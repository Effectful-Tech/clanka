import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as EmbeddingModel from "effect/unstable/ai/EmbeddingModel"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { Chunk, ChunkRepo, layer, SyncId } from "./ChunkRepo.ts"
import { SqliteLayer } from "./Sqlite.ts"

const withDatabase = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "clanka-"))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true })),
)

const sqliteLayer = (database: string) =>
  SqliteLayer(database).pipe(Layer.provide(NodeServices.layer))

describe("ChunkRepo", () => {
  it.live("backfills and synchronizes the vec0 index", () =>
    Effect.gen(function* () {
      const directory = yield* withDatabase
      const database = join(directory, "search.sqlite")
      const existingVector = new Float32Array([0, 1, 0])

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO chunks(path, content, hash, vector, syncId)
          VALUES ('existing.ts', 'existing', 'existing', ${existingVector}, 'sync')`
      }).pipe(Effect.provide(sqliteLayer(database)), Effect.scoped)

      const databaseLayer = sqliteLayer(database)
      const repoLayer = Layer.merge(
        layer.pipe(Layer.provide(databaseLayer)),
        databaseLayer,
      ).pipe(Layer.provide(Layer.succeed(EmbeddingModel.Dimensions, 3)))

      yield* Effect.gen(function* () {
        const repo = yield* ChunkRepo
        const sql = yield* SqlClient.SqlClient

        const backfilled = yield* repo.search({
          vector: existingVector,
          limit: 1,
        })
        assert.strictEqual(backfilled[0]?.path, "existing.ts")

        const inserted = yield* repo.insert(
          Chunk.insert.make({
            path: "inserted.ts",
            content: "inserted",
            hash: "inserted",
            vector: new Float32Array([1, 0, 0]),
            syncId: SyncId.make("sync"),
          }),
        )

        const insertedResult = yield* repo.search({
          vector: new Float32Array([1, 0, 0]),
          limit: 1,
        })
        assert.strictEqual(insertedResult[0]?.id, inserted.id)

        yield* sql`UPDATE chunks
          SET vector = ${new Float32Array([0, 0, 1])}
          WHERE id = ${inserted.id}`

        const updatedResult = yield* repo.search({
          vector: new Float32Array([0, 0, 1]),
          limit: 1,
        })
        assert.strictEqual(updatedResult[0]?.id, inserted.id)

        yield* repo.deleteByPath("inserted.ts")

        const deletedResult = yield* repo.search({
          vector: new Float32Array([0, 0, 1]),
          limit: 2,
        })
        assert.deepStrictEqual(
          deletedResult.map((chunk) => chunk.path),
          ["existing.ts"],
        )
      }).pipe(Effect.provide(repoLayer), Effect.scoped)
    }),
  )
})

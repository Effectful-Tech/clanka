/**
 * @since 1.0.0
 */
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Vector from "@sqliteai/sqlite-vector"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as FileSystem from "effect/FileSystem"

/**
 * @since 1.0.0
 * @category Layers
 */
export const SqliteLayer = SqliteMigrator.layer({
  loader: SqliteMigrator.fromRecord({
    "0001_create_chunks": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      yield* sql`CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        startLine INTEGER NOT NULL,
        endLine INTEGER NOT NULL,
        content TEXT NOT NULL,
        hash TEXT NOT NULL,
        vector BLOB NOT NULL,
        syncId TEXT NOT NULL
      )`

      yield* sql`CREATE INDEX IF NOT EXISTS idx_chunks_path_start_end ON chunks (path, startLine, hash)`
    }),
  }),
}).pipe(
  Layer.provide(
    Layer.effectDiscard(
      Effect.gen(function* () {
        const client = yield* SqliteClient.SqliteClient
        yield* client.loadExtension(Vector.getExtensionPath())
      }),
    ),
  ),
  Layer.provideMerge(
    SqliteClient.layer({
      filename: ".clanka/db.sqlite",
    }),
  ),
  Layer.provide(
    Layer.effectDiscard(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(".clanka", { recursive: true })
      }),
    ),
  ),
)

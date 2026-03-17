/**
 * @since 1.0.0
 */
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { getExtensionPath } from "./internal/sqlite-vector.ts"

/**
 * @since 1.0.0
 * @category Layers
 */
export const SqliteLayer = (database: string) =>
  SqliteMigrator.layer({
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
          yield* client.loadExtension(getExtensionPath())
        }),
      ),
    ),
    Layer.provideMerge(
      SqliteClient.layer({
        filename: database,
      }),
    ),
    Layer.provide(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const directory = path.dirname(database)
          if (directory === ".") return
          yield* fs.makeDirectory(directory, { recursive: true })
        }),
      ),
    ),
  )

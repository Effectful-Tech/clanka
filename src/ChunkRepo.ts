import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as Context from "effect/Context"
import * as Model from "effect/unstable/schema/Model"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import * as SqlModel from "effect/unstable/sql/SqlModel"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"
import type * as Cause from "effect/Cause"
import type * as Option from "effect/Option"
import * as EmbeddingModel from "effect/unstable/ai/EmbeddingModel"
import * as SqlResolver from "effect/unstable/sql/SqlResolver"
import * as RequestResolver from "effect/RequestResolver"

/**
 * @since 1.0.0
 * @category Models
 */
export const ChunkId = Schema.Number.pipe(Schema.brand("ChunkRepo/ChunkId"))
/**
 * @since 1.0.0
 * @category Models
 */
export type ChunkId = typeof ChunkId.Type

/**
 * @since 1.0.0
 * @category Models
 */
export const SyncId = Schema.String.pipe(Schema.brand("ChunkRepo/SyncId"))
/**
 * @since 1.0.0
 * @category Models
 */
export type SyncId = typeof SyncId.Type

/**
 * @since 1.0.0
 * @category Models
 */
export const Float32ArraySchema = Schema.instanceOf<
  Float32ArrayConstructor,
  Float32Array
>(Float32Array)

/**
 * @since 1.0.0
 * @category Models
 */
export const Float32ArrayFromArray = Schema.Array(Schema.Number).pipe(
  Schema.decodeTo(
    Float32ArraySchema,
    SchemaTransformation.transform({
      decode: (arr) => new Float32Array(arr),
      encode: (array) => Array.from(array),
    }),
  ),
)

/**
 * @since 1.0.0
 * @category Models
 */
export const Float32ArrayField = Model.Field({
  insert: Float32ArraySchema,
  update: Float32ArraySchema,
  jsonCreate: Float32ArrayFromArray,
  jsonUpdate: Float32ArrayFromArray,
})

/**
 * @since 1.0.0
 * @category Models
 */
export class Chunk extends Model.Class<Chunk>("Chunk")({
  id: ChunkId.pipe(Model.FieldExcept(["insert", "jsonCreate"])),
  path: Schema.String,
  content: Schema.String,
  hash: Schema.String,
  vector: Float32ArrayField,
  syncId: SyncId,
}) {}

/**
 * @since 1.0.0
 * @category Services
 */
export class ChunkRepo extends Context.Service<
  ChunkRepo,
  {
    insert(
      chunk: typeof Chunk.insert.Type,
    ): Effect.Effect<Chunk, ChunkRepoError>

    findById(
      id: ChunkId,
    ): Effect.Effect<Chunk, ChunkRepoError | Cause.NoSuchElementError>

    exists(hash: string): Effect.Effect<Option.Option<ChunkId>, ChunkRepoError>

    search(options: {
      readonly vector: Float32Array
      readonly limit: number
    }): Effect.Effect<Array<Chunk>, ChunkRepoError>

    quantize: Effect.Effect<void, ChunkRepoError>

    setSyncId(
      chunkId: ChunkId,
      syncId: SyncId,
    ): Effect.Effect<void, ChunkRepoError>
    deleteByPath(path: string): Effect.Effect<void, ChunkRepoError>
    deleteForSyncId(syncId: SyncId): Effect.Effect<void, ChunkRepoError>
  }
>()("clanka/ChunkRepo") {}

/**
 * @since 1.0.0
 * @category Errors
 */
export class ChunkRepoError extends Schema.TaggedErrorClass<ChunkRepoError>()(
  "ChunkRepoError",
  {
    reason: Schema.Union([SqlError.SqlError]),
  },
) {
  readonly cause = this.reason
  readonly message = this.reason.message
}

/**
 * @since 1.0.0
 * @category Layers
 */
export const layer = Layer.effect(
  ChunkRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const dimensions = yield* EmbeddingModel.Dimensions

    yield* Effect.gen(function* () {
      yield* sql`CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
        vector float[${sql.literal(String(dimensions))}]
      )`
      yield* sql`CREATE TRIGGER IF NOT EXISTS chunks_vector_insert
        AFTER INSERT ON chunks
        BEGIN
          INSERT INTO chunk_vectors(rowid, vector) VALUES (new.id, new.vector);
        END`
      yield* sql`CREATE TRIGGER IF NOT EXISTS chunks_vector_update
        AFTER UPDATE OF vector ON chunks
        BEGIN
          DELETE FROM chunk_vectors WHERE rowid = old.id;
          INSERT INTO chunk_vectors(rowid, vector) VALUES (new.id, new.vector);
        END`
      yield* sql`CREATE TRIGGER IF NOT EXISTS chunks_vector_delete
        AFTER DELETE ON chunks
        BEGIN
          DELETE FROM chunk_vectors WHERE rowid = old.id;
        END`
      yield* sql`DELETE FROM chunk_vectors
        WHERE rowid NOT IN (SELECT id FROM chunks)`
      yield* sql`INSERT INTO chunk_vectors(rowid, vector)
        SELECT id, vector FROM chunks
        WHERE id NOT IN (SELECT rowid FROM chunk_vectors)`
    }).pipe(sql.withTransaction)

    const loaders = yield* SqlModel.makeResolvers(Chunk, {
      tableName: "chunks",
      idColumn: "id",
      spanPrefix: "ChunkRepo",
    })

    const search = SqlSchema.findAll({
      Request: Schema.Struct({
        vector: Float32ArraySchema,
        limit: Schema.Number,
      }),
      Result: Chunk,
      execute: ({ vector, limit }) =>
        sql`
          select chunks.id, chunks.path, chunks.content, chunks.hash, chunks.syncId
          from chunk_vectors
          JOIN chunks ON chunks.id = chunk_vectors.rowid
          WHERE chunk_vectors.vector MATCH ${vector}
          AND k = CAST(${limit} AS INTEGER)
          ORDER BY chunk_vectors.distance
        `,
    })

    const exists = SqlResolver.findById({
      Id: Schema.String, // hash
      Result: Schema.Struct({
        id: ChunkId,
        hash: Schema.String,
      }),
      ResultId(result) {
        return result.hash
      },
      execute: (hashes) =>
        sql`select id, hash from chunks where ${sql.in("hash", hashes)}`,
    }).pipe(RequestResolver.setDelay(5))

    const insertResolver = loaders.insert.pipe(RequestResolver.setDelay(5))
    const findByIdResolver = loaders.findById.pipe(RequestResolver.setDelay(5))

    return ChunkRepo.of({
      insert: (insert) =>
        SqlResolver.request(insert, insertResolver).pipe(
          Effect.catchTags(
            {
              SchemaError: Effect.die,
              ResultLengthMismatch: Effect.die,
            },
            (reason) => Effect.fail(new ChunkRepoError({ reason })),
          ),
        ),
      findById: (id) =>
        SqlResolver.request(id, findByIdResolver).pipe(
          Effect.catchTags({
            SchemaError: Effect.die,
            SqlError: (reason) => Effect.fail(new ChunkRepoError({ reason })),
          }),
        ),
      exists: (hash) =>
        SqlResolver.request(hash, exists).pipe(
          Effect.map((result) => result.id),
          Effect.catchNoSuchElement,
          Effect.catchTags({
            SqlError: (reason) => Effect.fail(new ChunkRepoError({ reason })),
            SchemaError: Effect.die,
          }),
        ),
      search: Effect.fn("ChunkRepo.search")(function* (options) {
        return yield* search(options as any).pipe(
          Effect.catchTags({
            SqlError: (reason) => Effect.fail(new ChunkRepoError({ reason })),
            SchemaError: Effect.die,
          }),
        )
      }),
      quantize: Effect.void,
      setSyncId: (chunkId, syncId) =>
        sql`update chunks set syncId = ${syncId} where id = ${chunkId}`.pipe(
          Effect.mapError((reason) => new ChunkRepoError({ reason })),
        ),
      deleteByPath: (path) =>
        sql`delete from chunks where path = ${path}`.pipe(
          Effect.mapError((reason) => new ChunkRepoError({ reason })),
        ),
      deleteForSyncId: (syncId) =>
        sql`delete from chunks where syncId != ${syncId}`.pipe(
          Effect.mapError((reason) => new ChunkRepoError({ reason })),
        ),
    })
  }),
)

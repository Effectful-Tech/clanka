/**
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as ChunkRepo from "./ChunkRepo.ts"
import * as CodeChunker from "./CodeChunker.ts"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { pipe } from "effect/Function"
import * as EmbeddingModel from "effect/unstable/ai/EmbeddingModel"
import * as RequestResolver from "effect/RequestResolver"
import * as Option from "effect/Option"
import type * as Path from "effect/Path"
import * as ServiceMap from "effect/ServiceMap"
import * as Fiber from "effect/Fiber"
import * as Duration from "effect/Duration"
import * as FiberHandle from "effect/FiberHandle"
import { SqliteLayer } from "./Sqlite.ts"
import type * as SqlError from "effect/unstable/sql/SqlError"
import type * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator"
import type * as PlatformError from "effect/PlatformError"
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import type * as FileSystem from "effect/FileSystem"
import * as Console from "effect/Console"

/**
 * @since 1.0.0
 * @category Services
 */
export class SemanticSearch extends ServiceMap.Service<
  SemanticSearch,
  {
    search(options: {
      readonly query: string
      readonly limit: number
    }): Effect.Effect<string>
    readonly reindex: Effect.Effect<void>
  }
>()("clanka/SemanticSearch/SemanticSearch") {}

/**
 * @since 1.0.0
 * @category Layers
 */
export const layer = (options: {
  readonly directory: string
  readonly database?: string | undefined
  readonly embeddingBatchSize?: number | undefined
  readonly embeddingRequestDelay?: Duration.Input | undefined
  readonly concurrency?: number | undefined
}): Layer.Layer<
  SemanticSearch,
  | SqlError.SqlError
  | SqliteMigrator.MigrationError
  | PlatformError.PlatformError,
  | EmbeddingModel.EmbeddingModel
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | EmbeddingModel.Dimensions
> =>
  Layer.effect(
    SemanticSearch,
    Effect.gen(function* () {
      const chunker = yield* CodeChunker.CodeChunker
      const repo = yield* ChunkRepo.ChunkRepo
      const embeddings = yield* EmbeddingModel.EmbeddingModel
      const resolver = embeddings.resolver.pipe(
        RequestResolver.setDelay(
          options.embeddingBatchSize ?? Duration.millis(50),
        ),
        RequestResolver.batchN(options.embeddingBatchSize ?? 500),
      )
      const indexHandle = yield* FiberHandle.make()
      const console = yield* Console.Console

      const index = Effect.gen(function* () {
        const syncId = ChunkRepo.SyncId.makeUnsafe(crypto.randomUUID())
        yield* Effect.logInfo("Starting SemanticSearch index")

        yield* pipe(
          chunker.chunkCodebase({
            root: options.directory,
            chunkSize: 20,
            chunkOverlap: 5,
          }),
          Stream.tap(
            Effect.fnUntraced(
              function* (chunk) {
                const id = yield* repo.exists({
                  path: chunk.path,
                  startLine: chunk.startLine,
                  hash: chunk.contentHash,
                })
                if (Option.isSome(id)) {
                  yield* repo.setSyncId(id.value, syncId)
                  return
                }
                const result = yield* Effect.request(
                  new EmbeddingModel.EmbeddingRequest({
                    input: `File: ${chunk.path}
Lines: ${chunk.startLine}-${chunk.endLine}

${chunk.content}`,
                  }),
                  resolver,
                )
                const vector = new Float32Array(result.vector)
                yield* repo.insert(
                  ChunkRepo.Chunk.insert.makeUnsafe({
                    path: chunk.path,
                    startLine: chunk.startLine,
                    endLine: chunk.endLine,
                    hash: chunk.contentHash,
                    content: chunk.content,
                    vector,
                    syncId,
                  }),
                )
              },
              Effect.ignore({
                log: "Warn",
                message: "Failed to process chunk for embedding",
              }),
              (effect, chunk) =>
                Effect.annotateLogs(effect, {
                  chunk: `${chunk.path}/${chunk.startLine}`,
                }),
            ),
            { concurrency: options.concurrency ?? 2000 },
          ),
          Stream.runDrain,
        )

        yield* Effect.logInfo("Finished SemanticSearch index")
      }).pipe(
        Effect.withSpan("SemanticSearch.index"),
        Effect.withLogSpan("SemanticSearch.index"),
        Effect.provideService(Console.Console, console),
      )

      const runIndex = FiberHandle.run(indexHandle, index, {
        onlyIfMissing: true,
      })

      const initialIndex = yield* runIndex
      yield* runIndex.pipe(
        Effect.delay(Duration.minutes(3)),
        Effect.forever,
        Effect.forkScoped,
      )

      return SemanticSearch.of({
        search: Effect.fn("SemanticSearch.search")(function* (options) {
          yield* Fiber.join(initialIndex)
          yield* Effect.annotateCurrentSpan(options)
          const { vector } = yield* embeddings.embed(options.query)
          const results = yield* repo.search({
            vector: new Float32Array(vector),
            limit: options.limit,
          })
          return results.map((r) => r.format()).join("\n\n")
        }, Effect.orDie),
        reindex: Effect.asVoid(runIndex),
      })
    }),
  ).pipe(
    Layer.provide([
      CodeChunker.layer,
      ChunkRepo.layer.pipe(
        Layer.provide(SqliteLayer(options.database ?? ".clanka/search.sqlite")),
      ),
    ]),
  )

/**
 * @since 1.0.0
 * @category Utils
 */
export const maybeReindex: Effect.Effect<void> = Effect.serviceOption(
  SemanticSearch,
).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.void,
      onSome: (service) => service.reindex,
    }),
  ),
)

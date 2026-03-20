/**
 * @since 1.0.0
 */
import { createHash } from "node:crypto"
import * as Effect from "effect/Effect"
import * as ChunkRepo from "./ChunkRepo.ts"
import * as CodeChunker from "./CodeChunker.ts"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { pipe } from "effect/Function"
import * as EmbeddingModel from "effect/unstable/ai/EmbeddingModel"
import * as RequestResolver from "effect/RequestResolver"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
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
    updateFile(path: string): Effect.Effect<void>
    removeFile(path: string): Effect.Effect<void>
  }
>()("clanka/SemanticSearch/SemanticSearch") {}

const normalizePath = (path: string) => path.replace(/\\/g, "/")

const resolveChunkConfig = (options: {
  readonly chunkMaxCharacters?: number | undefined
}) => ({
  chunkSize: 30,
  chunkOverlap: 0,
  chunkMaxCharacters: options.chunkMaxCharacters ?? 30_000,
})

export const makeEmbeddingResolver = (
  resolver: EmbeddingModel.Service["resolver"],
  options: {
    readonly embeddingBatchSize?: number | undefined
    readonly embeddingRequestDelay?: Duration.Input | undefined
  },
): EmbeddingModel.Service["resolver"] =>
  resolver.pipe(
    RequestResolver.setDelay(
      options.embeddingRequestDelay ?? Duration.millis(50),
    ),
    RequestResolver.batchN(options.embeddingBatchSize ?? 500),
  )

export const chunkEmbeddingInput = (chunk: CodeChunker.CodeChunk): string => {
  const headerLines = ["---", "file: " + chunk.path]

  if (chunk.name !== undefined) {
    headerLines.push("name: " + chunk.name)
  }
  if (chunk.type !== undefined) {
    headerLines.push("type: " + chunk.type)
  }
  if (chunk.parent !== undefined) {
    headerLines.push("parent: " + chunk.parent)
  }
  headerLines.push("---")

  const contentLines = chunk.content.split("\n")
  let contentWithLines = ""
  for (let i = 0; i < contentLines.length; i++) {
    if (i > 0) {
      contentWithLines += "\n"
    }
    contentWithLines += `${chunk.startLine + i}: ${contentLines[i]}`
  }

  return headerLines.join("\n") + "\n\n" + contentWithLines
}

const hashChunkInput = (input: string): string =>
  createHash("sha256").update(input).digest("hex")

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
  readonly chunkMaxCharacters?: number | undefined
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
      const pathService = yield* Path.Path
      const root = pathService.resolve(options.directory)
      const resolver = makeEmbeddingResolver(embeddings.resolver, options)
      const concurrency = options.concurrency ?? 2000
      const chunkConfig = resolveChunkConfig(options)
      const indexHandle = yield* FiberHandle.make()
      const console = yield* Console.Console

      const resolveIndexedPath = (path: string): Option.Option<string> => {
        const absolutePath = pathService.resolve(root, path)
        const relativePath = normalizePath(
          pathService.relative(root, absolutePath),
        )
        if (
          relativePath.length === 0 ||
          relativePath === ".." ||
          relativePath.startsWith("../")
        ) {
          return Option.none()
        }
        return Option.some(relativePath)
      }

      const processChunk = Effect.fnUntraced(
        function* (options: {
          readonly chunk: CodeChunker.CodeChunk
          readonly syncId: ChunkRepo.SyncId
          readonly checkExisting: boolean
        }) {
          const input = chunkEmbeddingInput(options.chunk)
          const hash = hashChunkInput(input)

          if (options.checkExisting) {
            const id = yield* repo.exists(hash)
            if (Option.isSome(id)) {
              yield* repo.setSyncId(id.value, options.syncId)
              return
            }
          }

          const result = yield* Effect.request(
            new EmbeddingModel.EmbeddingRequest({ input }),
            resolver,
          )
          const vector = new Float32Array(result.vector)
          yield* repo.insert(
            ChunkRepo.Chunk.insert.makeUnsafe({
              path: options.chunk.path,
              hash,
              content: input,
              vector,
              syncId: options.syncId,
            }),
          )
        },
        Effect.ignore({
          log: "Warn",
          message: "Failed to process chunk for embedding",
        }),
        (effect, options) =>
          Effect.annotateLogs(effect, {
            chunk: `${options.chunk.path}/${options.chunk.startLine}`,
          }),
      )

      const index = Effect.gen(function* () {
        const syncId = ChunkRepo.SyncId.makeUnsafe(crypto.randomUUID())
        yield* Effect.logInfo("Starting SemanticSearch index")

        yield* pipe(
          chunker.chunkCodebase({
            root,
            ...chunkConfig,
          }),
          Stream.tap(
            (chunk) =>
              processChunk({
                chunk,
                syncId,
                checkExisting: true,
              }),
            { concurrency },
          ),
          Stream.runDrain,
        )

        yield* repo.deleteForSyncId(syncId)

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
          return results.map((r) => r.content).join("\n\n")
        }, Effect.orDie),
        updateFile: Effect.fn("SemanticSearch.updateFile")(function* (path) {
          yield* Fiber.join(initialIndex)
          const indexedPath = resolveIndexedPath(path)
          if (Option.isNone(indexedPath)) {
            return
          }

          yield* repo.deleteByPath(indexedPath.value)

          const chunks = yield* chunker.chunkFile({
            root,
            path: indexedPath.value,
            ...chunkConfig,
          })
          if (chunks.length === 0) {
            return
          }

          const syncId = ChunkRepo.SyncId.makeUnsafe(crypto.randomUUID())

          yield* pipe(
            Stream.fromArray(chunks),
            Stream.tap(
              (chunk) =>
                processChunk({
                  chunk,
                  syncId,
                  checkExisting: false,
                }),
              { concurrency },
            ),
            Stream.runDrain,
          )
        }, Effect.orDie),
        removeFile: Effect.fn("SemanticSearch.removeFile")(function* (path) {
          yield* Fiber.join(initialIndex)
          const indexedPath = resolveIndexedPath(path)
          if (Option.isNone(indexedPath)) {
            return
          }
          yield* repo.deleteByPath(indexedPath.value)
        }, Effect.orDie),
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
export const maybeUpdateFile = (path: string): Effect.Effect<void> =>
  Effect.serviceOption(SemanticSearch).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (service) => service.updateFile(path),
      }),
    ),
  )

/**
 * @since 1.0.0
 * @category Utils
 */
export const maybeRemoveFile = (path: string): Effect.Effect<void> =>
  Effect.serviceOption(SemanticSearch).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (service) => service.removeFile(path),
      }),
    ),
  )

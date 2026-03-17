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

export class SemanticSearch extends ServiceMap.Service<
  SemanticSearch,
  {
    search(options: {
      readonly query: string
      readonly limit: number
    }): Effect.Effect<string>
  }
>()("clanka/SemanticSearch/SemanticSearch") {}

export const layer = Layer.effect(
  SemanticSearch,
  Effect.gen(function* () {
    const chunker = yield* CodeChunker.CodeChunker
    const repo = yield* ChunkRepo.ChunkRepo
    const embeddings = yield* EmbeddingModel.EmbeddingModel
    const pathService = yield* Path.Path
    const resolver = embeddings.resolver.pipe(
      RequestResolver.setDelay(50),
      RequestResolver.batchN(500),
    )

    const index = Effect.gen(function* () {
      const syncId = ChunkRepo.SyncId.makeUnsafe(crypto.randomUUID())

      yield* pipe(
        chunker.chunkCodebase(),
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
              const module = pathService.basename(chunk.path)
              const directory = pathService.dirname(chunk.path)
              const result = yield* Effect.request(
                new EmbeddingModel.EmbeddingRequest({
                  input: `Module: ${module}
Directory: ${directory}
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
          { concurrency: 5000 },
        ),
        Stream.runDrain,
      )
    }).pipe(Effect.withSpan("SemanticSearch.index"))

    const initialIndex = yield* Effect.forkScoped(index)

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
    })
  }),
).pipe(Layer.provide([CodeChunker.layer, ChunkRepo.layer]))

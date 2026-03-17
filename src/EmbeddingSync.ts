import * as Effect from "effect/Effect"
import * as ChunkRepo from "./ChunkRepo.ts"
import * as CodeChunker from "./CodeChunker.ts"
import * as Layer from "effect/Layer"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as Stream from "effect/Stream"
import { pipe } from "effect/Function"
import * as EmbeddingModel from "effect/unstable/ai/EmbeddingModel"
import * as OpenAiClient from "@effect/ai-openai/OpenAiClient"
import { OpenAiEmbeddingModel } from "@effect/ai-openai"
import * as RequestResolver from "effect/RequestResolver"
import * as Config from "effect/Config"
import * as Option from "effect/Option"

const OpenAiClientLayer = OpenAiClient.layerConfig({
  apiKey: Config.redacted("OPENAI_API_KEY"),
}).pipe(Layer.provide(NodeHttpClient.layerUndici))

const Model = OpenAiEmbeddingModel.model("text-embedding-3-small").pipe(
  Layer.provide(OpenAiClientLayer),
)

Effect.gen(function* () {
  const chunker = yield* CodeChunker.CodeChunker
  const repo = yield* ChunkRepo.ChunkRepo
  const embeddings = yield* EmbeddingModel.EmbeddingModel
  const resolver = embeddings.resolver.pipe(RequestResolver.setDelay(50))

  const syncId = ChunkRepo.SyncId.makeUnsafe(crypto.randomUUID())

  yield* pipe(
    chunker.chunkCodebase(),
    Stream.tap(
      Effect.fnUntraced(
        function* (chunk) {
          yield* Effect.log("Processing")
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
            new EmbeddingModel.EmbeddingRequest({ input: chunk.content }),
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
          yield* Effect.log("Processed")
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
      { concurrency: 100 },
    ),
    Stream.runDrain,
  )

  yield* repo.deleteForSyncId(syncId)

  const { vector } = yield* embeddings.embed("web search tool")
  const results = yield* repo.search({
    vector: new Float32Array(vector),
    limit: 10,
  })
  console.dir(results, { depth: null })
}).pipe(
  Effect.provide(
    Layer.mergeAll(CodeChunker.layer, ChunkRepo.layer, Model).pipe(
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
  NodeRuntime.runMain,
)

import { Config, Effect, Layer } from "effect"
import { SemanticSearch } from "clanka"
import {
  NodeHttpClient,
  NodeRuntime,
  NodeServices,
} from "@effect/platform-node"
import { OpenAiClient, OpenAiEmbeddingModel } from "@effect/ai-openai"

const Search = SemanticSearch.layer({
  directory: process.cwd(),
  database: ".lalph/shared/search.sqlite",
}).pipe(
  Layer.provide(
    OpenAiEmbeddingModel.model("text-embedding-3-small", {
      dimensions: 1536,
    }),
  ),
  Layer.provide(
    OpenAiClient.layerConfig({
      apiKey: Config.redacted("OPENAI_API_KEY"),
    }),
  ),
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(NodeServices.layer),
)

Effect.gen(function* () {
  const search = yield* SemanticSearch.SemanticSearch

  console.log(
    yield* search.search({
      query: process.argv.slice(2).join(" "),
      limit: 10,
    }),
  )
}).pipe(Effect.provide(Search), NodeRuntime.runMain)

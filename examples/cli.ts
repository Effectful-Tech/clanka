import { Config, Effect, Layer, Stream } from "effect"
import { Agent, Codex, Copilot, OutputFormatter, SemanticSearch } from "clanka"
import {
  NodeHttpClient,
  NodeRuntime,
  NodeServices,
  NodeSocket,
} from "@effect/platform-node"
import { KeyValueStore } from "effect/unstable/persistence"
import * as NodePath from "node:path"
import { OpenAiClient, OpenAiEmbeddingModel } from "@effect/ai-openai"

const XDG_CONFIG_HOME =
  process.env.XDG_CONFIG_HOME ||
  NodePath.join(process.env.HOME || "", ".config")
console.log(`Using config directory: ${XDG_CONFIG_HOME}`)

const ModelServices = Codex.layerClient.pipe(
  Layer.provide(
    KeyValueStore.layerFileSystem(NodePath.join(XDG_CONFIG_HOME, "clanka")),
  ),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.merge(NodeSocket.layerWebSocketConstructorWS),
)

const Gpt54 = Codex.modelWebSocket("gpt-5.3-codex", {
  reasoning: {
    effort: "high",
  },
}).pipe(Layer.provide(ModelServices))

export const Opus = Copilot.model("claude-opus-4.6", {
  thinking: { thinking_budget: 4000 },
}).pipe(Layer.provideMerge(ModelServices))

const SubAgentModel = Codex.model("gpt-5.4", {
  reasoning: {
    effort: "low",
    summary: "auto",
  },
}).pipe(Layer.provide(ModelServices))

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

const AgentLayer = Agent.layerLocal({
  directory: process.cwd(),
}).pipe(
  Layer.provide(NodeServices.layer),
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(Search),
)

Effect.gen(function* () {
  const agent = yield* Agent.Agent

  const output = yield* agent.send({
    prompt: process.argv.slice(2).join(" "),
  })
  yield* output.pipe(
    OutputFormatter.pretty,
    Stream.runForEachArray((chunk) => {
      for (const out of chunk) {
        process.stdout.write(out)
      }
      return Effect.void
    }),
  )
}).pipe(
  Effect.scoped,
  Effect.provide([AgentLayer, Gpt54, Agent.layerSubagentModel(SubAgentModel)]),
  NodeRuntime.runMain,
)

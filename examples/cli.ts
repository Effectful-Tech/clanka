import { Effect, Layer, Stream } from "effect"
import { Agent, Codex, OutputFormatter } from "../src/index.ts"
import {
  NodeHttpClient,
  NodeRuntime,
  NodeServices,
} from "@effect/platform-node"
import { OpenAiLanguageModel } from "@effect/ai-openai"
import { KeyValueStore } from "effect/unstable/persistence"

const Kvs = KeyValueStore.layerFileSystem("./data")

const CodexLayer = Codex.CodexAiClient.pipe(
  Layer.provide(Kvs),
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(NodeServices.layer),
)

const AgentModel = OpenAiLanguageModel.model("gpt-5.4", {
  reasoning: {
    effort: "medium",
    summary: "auto",
  },
}).pipe(Layer.provide(CodexLayer))

const SubAgentModel = OpenAiLanguageModel.model("gpt-5.3-codex-spark", {
  reasoning: {
    effort: "medium",
    summary: "auto",
  },
}).pipe(Layer.provide(CodexLayer))

const AgentServices = Agent.layerServices.pipe(
  Layer.merge(AgentModel),
  Layer.provideMerge(NodeServices.layer),
)

Effect.gen(function* () {
  const agent = yield* Agent.make({
    directory: process.cwd(),
    prompt: process.argv.slice(2).join(" "),
    subagentModel: SubAgentModel,
  })
  yield* agent.output.pipe(
    Stream.run(OutputFormatter.pretty),
    Effect.catch((finished) => Effect.log(finished.summary)),
  )
}).pipe(Effect.scoped, Effect.provide(AgentServices), NodeRuntime.runMain)

import { Effect, Layer, Stream } from "effect"
import { Agent, Codex, GithubCopilot, OutputFormatter } from "../src/index.ts"
import {
  NodeHttpClient,
  NodeRuntime,
  NodeServices,
} from "@effect/platform-node"
import { OpenAiLanguageModel } from "@effect/ai-openai"
import { OpenAiLanguageModel as CompatModel } from "@effect/ai-openai-compat"
import { KeyValueStore } from "effect/unstable/persistence"

const Kvs = KeyValueStore.layerFileSystem("./data")

const CodexLayer = Codex.layer.pipe(
  Layer.provide(Kvs),
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(NodeServices.layer),
)
const CopilotLayer = GithubCopilot.layer.pipe(
  Layer.provide(Kvs),
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(NodeServices.layer),
)

const AgentModel = OpenAiLanguageModel.model("gpt-5.4", {
  reasoning: {
    effort: "high",
    summary: "auto",
  },
}).pipe(Layer.provideMerge(CodexLayer))

const Opus = CompatModel.model("claude-opus-4.6", {
  thinking: { thinking_budget: 4000 },
}).pipe(Layer.provideMerge(CopilotLayer))

const SubAgentModel = OpenAiLanguageModel.model("gpt-5.4", {
  reasoning: {
    effort: "medium",
    summary: "auto",
  },
}).pipe(Layer.provide(CodexLayer))

const AgentServices = Agent.layerServices.pipe(
  Layer.merge(Opus),
  Layer.provideMerge(NodeServices.layer),
)

Effect.gen(function* () {
  const agent = yield* Agent.make({
    directory: process.cwd(),
    prompt: process.argv.slice(2).join(" "),
    subagentModel: SubAgentModel,
  })
  yield* agent.output.pipe(
    OutputFormatter.pretty,
    Stream.runForEachArray((chunk) => {
      for (const out of chunk) {
        process.stdout.write(out)
      }
      return Effect.void
    }),
  )
}).pipe(Effect.scoped, Effect.provide(AgentServices), NodeRuntime.runMain)

import { Effect, Layer, Stream } from "effect"
import { Agent, Codex, Copilot, OutputFormatter } from "../src/index.ts"
import {
  NodeHttpClient,
  NodeRuntime,
  NodeServices,
} from "@effect/platform-node"
import { KeyValueStore } from "effect/unstable/persistence"

const ModelServices = KeyValueStore.layerFileSystem("./data").pipe(
  Layer.provide(NodeServices.layer),
  Layer.merge(NodeHttpClient.layerUndici),
)

const Gpt54 = Codex.model("gpt-5.4", {
  reasoning: {
    effort: "medium",
  },
}).pipe(Layer.provide(ModelServices))

const Opus = Copilot.model("claude-opus-4.6", {
  thinking: { thinking_budget: 4000 },
}).pipe(Layer.provideMerge(ModelServices))

const SubAgentModel = Codex.model("gpt-5.4", {
  reasoning: {
    effort: "low",
    summary: "auto",
  },
}).pipe(Layer.provide(ModelServices))

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

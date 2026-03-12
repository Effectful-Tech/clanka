import { Effect, Layer, Stream } from "effect"
import { Agent, Codex, Copilot, OutputFormatter } from "../src/index.ts"
import {
  NodeHttpClient,
  NodeRuntime,
  NodeServices,
} from "@effect/platform-node"
import { KeyValueStore } from "effect/unstable/persistence"
import * as NodePath from "node:path"

const XDG_CONFIG_HOME =
  process.env.XDG_CONFIG_HOME ||
  NodePath.join(process.env.HOME || "", ".config")

console.log(`Using config directory: ${XDG_CONFIG_HOME}`)
const ModelServices = KeyValueStore.layerFileSystem(
  NodePath.join(XDG_CONFIG_HOME, "clanka"),
).pipe(
  Layer.provide(NodeServices.layer),
  Layer.merge(NodeHttpClient.layerUndici),
)

const Gpt54 = Codex.model("gpt-5.3-codex", {
  reasoning: {
    effort: "high",
  },
}).pipe(Layer.provide(ModelServices))

const _Opus = Copilot.model("claude-opus-4.6", {
  thinking: { thinking_budget: 4000 },
}).pipe(Layer.provideMerge(ModelServices))

const SubAgentModel = Codex.model("gpt-5.4", {
  reasoning: {
    effort: "low",
    summary: "auto",
  },
}).pipe(Layer.provide(ModelServices))

const AgentServices = Agent.layerServices.pipe(
  Layer.merge(Gpt54),
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(NodeHttpClient.layerUndici),
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

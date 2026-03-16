import { Effect, Layer, pipe, Stream } from "effect"
import { Agent, Codex, Copilot, OutputFormatter } from "clanka"
import {
  NodeHttpClient,
  NodeRuntime,
  NodeServices,
  NodeSocket,
} from "@effect/platform-node"
import { KeyValueStore } from "effect/unstable/persistence"
import * as NodePath from "node:path"

const XDG_CONFIG_HOME =
  process.env.XDG_CONFIG_HOME ||
  NodePath.join(process.env.HOME || "", ".config")
console.log(`Using config directory: ${XDG_CONFIG_HOME}`)

const ModelServices = Codex.layerClient.pipe(
  Layer.provide(
    KeyValueStore.layerFileSystem(NodePath.join(XDG_CONFIG_HOME, "clanka")),
  ),
  Layer.provide(NodeServices.layer),
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

const AgentLayer = Agent.layerLocal({
  directory: process.cwd(),
}).pipe(
  Layer.provide(NodeServices.layer),
  Layer.provide(NodeHttpClient.layerUndici),
)

Effect.gen(function* () {
  const agent = yield* Agent.Agent

  const output = yield* pipe(
    agent.send({
      prompt: process.argv.slice(2).join(" "),
    }),
    Effect.provide([Gpt54, Agent.layerSubagentModel(SubAgentModel)]),
  )
  yield* output.pipe(
    OutputFormatter.pretty,
    Stream.runForEachArray((chunk) => {
      for (const out of chunk) {
        process.stdout.write(out)
      }
      return Effect.void
    }),
  )
}).pipe(Effect.scoped, Effect.provide(AgentLayer), NodeRuntime.runMain)

import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer, pipe, Schema, Stream } from "effect"
import { Chat, Prompt, Tool, Toolkit } from "effect/unstable/ai"
import { CodexAiClient } from "./Codex.ts"
import { KeyValueStore } from "effect/unstable/persistence"
import { OpenAiLanguageModel } from "@effect/ai-openai"
import { ToolkitRenderer } from "./ToolkitRenderer.ts"
import {
  AgentToolHandlers,
  AgentTools,
  CurrentDirectory,
} from "./AgentTools.ts"
import { Executor } from "./Executor.ts"

const Tools = Toolkit.make(
  Tool.make("execute", {
    description: "Execute javascript",
    parameters: Schema.Struct({
      script: Schema.String,
    }),
    success: Schema.String,
    dependencies: [CurrentDirectory],
  }),
)

const ToolsLayer = Tools.toLayer(
  Effect.gen(function* () {
    const executor = yield* Executor
    const tools = yield* AgentTools
    return Tools.of({
      execute: ({ script }) => {
        console.log("Executing script:", script)
        return executor
          .execute({
            tools,
            script,
          })
          .pipe(Stream.mkString)
      },
    })
  }),
).pipe(Layer.provide([AgentToolHandlers, Executor.layer]))

const ClientLayer = CodexAiClient.pipe(
  Layer.provide(KeyValueStore.layerFileSystem("data")),
  Layer.provide(NodeServices.layer),
)

Effect.gen(function* () {
  const renderer = yield* ToolkitRenderer
  const chat = yield* Chat.fromPrompt(process.argv[2]!)
  const toolkit = yield* Tools

  const result = yield* Effect.gen(function* () {
    while (true) {
      let hadToolCall = false
      yield* pipe(
        chat.streamText({ prompt: Prompt.empty, toolkit }),
        Stream.runForEach((part) => {
          switch (part.type) {
            case "tool-call":
              hadToolCall = true
              break
            case "text-delta":
              process.stdout.write(part.delta)
              break
            case "text-end":
              console.log("")
              break
            case "reasoning-delta":
              process.stdout.write(part.delta)
              break
            case "reasoning-end":
              console.log("")
              break
          }
          return Effect.void
        }),
      )
      if (!hadToolCall) break
    }
  }).pipe(
    Effect.provideService(CurrentDirectory, process.cwd()),
    OpenAiLanguageModel.withConfigOverride({
      instructions: `You are a professional software engineer. You are precise, thoughtful and concise. You make changes with care and always do the due diligence to ensure the best possible outcome. You make no mistakes.

- You only add comments when necessary.
- You do the research before making changes.

Use the "execute" tool to run javascript code to interact with the system.
Use \`console.log\` to print any output you need.
Top level await is supported.
You have the following functions available to you:

\`\`\`ts
${renderer.render(AgentTools)}
\`\`\`

An example script to read a file:

\`\`\`
const content = await readFile({
  path: "package.json",
  startLine: 1,
  endLine: 10,
})
console.log(content)
\`\`\`
`,
    }),
  )

  console.log("Result:", result)
}).pipe(
  Effect.provide([
    ToolsLayer,
    ToolkitRenderer.layer,
    OpenAiLanguageModel.model("gpt-5.4", {
      store: false,
      reasoning: {
        effort: "high",
        summary: "auto",
      },
    }).pipe(Layer.provide(ClientLayer)),
  ]),
  NodeRuntime.runMain,
)

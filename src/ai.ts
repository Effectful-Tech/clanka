import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Deferred, Effect, FileSystem, Layer, pipe, Stream } from "effect"
import { Chat, Prompt } from "effect/unstable/ai"
import { CodexAiClient } from "./Codex.ts"
import { KeyValueStore } from "effect/unstable/persistence"
import { OpenAiLanguageModel } from "@effect/ai-openai"
import { ToolkitRenderer } from "./ToolkitRenderer.ts"
import {
  AgentToolHandlers,
  AgentTools,
  CurrentDirectory,
  TaskCompleteDeferred,
} from "./AgentTools.ts"
import { Executor } from "./Executor.ts"

const ClientLayer = CodexAiClient.pipe(
  Layer.provide(KeyValueStore.layerFileSystem("data")),
  Layer.provide(NodeServices.layer),
)

Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const renderer = yield* ToolkitRenderer
  const chat = yield* Chat.fromPrompt(process.argv[2]!)
  const deferred = yield* Deferred.make<string>()
  const executor = yield* Executor
  const tools = yield* AgentTools

  const agentsMd = yield* fs.readFileString("AGENTS.md")

  const result = yield* Effect.gen(function* () {
    let output = ""
    while (true) {
      let prompt = Prompt.empty
      if (output.length > 0) {
        console.log("Executing script:\n", output, "\n\n")
        const result = yield* pipe(
          executor.execute({
            tools,
            script: output,
          }),
          Stream.mkString,
        )
        console.log("Result:")
        console.log(result.slice(0, 1000))
        prompt = Prompt.make(result)
        output = ""
      }
      yield* pipe(
        chat.streamText({ prompt }),
        Stream.takeUntil((part) => part.type === "text-end"),
        Stream.runForEach((part) => {
          switch (part.type) {
            case "text-delta":
              output += part.delta
              break
            case "reasoning-delta":
              process.stdout.write(part.delta)
              break
            case "reasoning-end":
              console.log("\n")
              break
            case "finish":
              console.log("Tokens used:", part.usage, "\n")
              break
          }
          return Effect.void
        }),
        Effect.tapCause(Effect.logError),
      )
      output = output.trim()
    }
  }).pipe(
    Effect.race(Deferred.await(deferred)),
    Effect.provideService(CurrentDirectory, process.cwd()),
    Effect.provideService(TaskCompleteDeferred, deferred),
    OpenAiLanguageModel.withConfigOverride({
      instructions: `You are a professional software engineer. You are precise, thoughtful and concise. You make changes with care and always do the due diligence to ensure the best possible outcome. You make no mistakes.

- You only add comments when necessary.
- You do the research before making changes.

From now on only respond with javascript code.

- Do not add any markdown formatting, just code.
- Use \`console.log\` to print any output you need.
- Top level await is supported.
- Avoid writing python or using bash to execute python

You have the following functions available to you:

\`\`\`ts
${renderer.render(AgentTools)}

declare const fetch: typeof globalThis.fetch
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

# Information from the user

**Always consider** the following information when making decisions:

---

${agentsMd}`,
    }),
  )

  console.log("Result:", result)
}).pipe(
  Effect.provide([
    AgentToolHandlers,
    Executor.layer,
    ToolkitRenderer.layer,
    OpenAiLanguageModel.model("gpt-5.4", {
      store: false,
      reasoning: {
        effort: "medium",
        summary: "auto",
      },
    }).pipe(Layer.provide(ClientLayer)),
    NodeServices.layer,
  ]),
  NodeRuntime.runMain,
)

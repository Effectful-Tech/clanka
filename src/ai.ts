import { NodeRuntime, NodeServices } from "@effect/platform-node"
import {
  Array,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  pipe,
  Stream,
} from "effect"
import { LanguageModel, Prompt } from "effect/unstable/ai"
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
import { StreamPart } from "effect/unstable/ai/Response"

const ClientLayer = CodexAiClient.pipe(
  Layer.provide(KeyValueStore.layerFileSystem("data")),
  Layer.provide(NodeServices.layer),
)

Effect.gen(function* () {
  const ai = yield* LanguageModel.LanguageModel
  const fs = yield* FileSystem.FileSystem
  const renderer = yield* ToolkitRenderer
  const deferred = yield* Deferred.make<string>()
  const executor = yield* Executor
  const tools = yield* AgentTools

  const agentsMd = yield* fs.readFileString("AGENTS.md")
  let prompt = Prompt.make([
    { role: "user", content: process.argv[2]! },
    {
      role: "user",
      content: `Here is a copy of ./AGENTS.md. ALWAYS follow these instructions when completing the above task:

${agentsMd}`,
    },
  ])

  const result = yield* Effect.gen(function* () {
    let output = ""
    while (true) {
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
        console.log(
          result.length > 1500
            ? result.slice(0, 1500) + "\n\n[output truncated]"
            : result,
        )
        prompt = Prompt.concat(prompt, `Javascript output:\n\n${result}`)
        output = ""
      }

      if (Deferred.isDoneUnsafe(deferred)) {
        return yield* Deferred.await(deferred)
      }

      let response = Array.empty<StreamPart<{}>>()
      yield* pipe(
        ai.streamText({ prompt }),
        Stream.takeUntil((part) => part.type === "text-end"),
        Stream.runForEachArray((parts) => {
          response.push(...parts)
          for (const part of parts) {
            switch (part.type) {
              case "text-start":
                output = ""
                break
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
          }
          return Effect.void
        }),
        Effect.tapCause(Effect.logError),
        Effect.retry({
          while: (err) => {
            response = []
            return err.isRetryable
          },
        }),
      )
      prompt = Prompt.concat(prompt, Prompt.fromResponseParts(response))
      output = output.trim()
    }
  }).pipe(
    Effect.provideService(CurrentDirectory, process.cwd()),
    Effect.provideService(TaskCompleteDeferred, deferred),
    OpenAiLanguageModel.withConfigOverride({
      instructions: `You are a professional software engineer. You are precise, thoughtful and concise. You make changes with care and always do the due diligence to ensure the best possible outcome. You make no mistakes.

- You only add comments when necessary.
- You do the research before making changes.

To interact with the system, respond with javascript code which will be executed for you.

- Do not add any markdown formatting, just code.
- Use \`console.log\` to print any output you need.
- Top level await is supported.
- Avoid writing python or using bash to execute python

You have the following functions available to you:

\`\`\`ts
${renderer.render(AgentTools)}

declare const fetch: typeof globalThis.fetch
\`\`\`

Here is how you would read a file:

\`\`\`
const content = await readFile({
  path: "package.json",
  startLine: 1,
  endLine: 10,
})
console.log(content)
\`\`\`

And the output would look like this:

\`\`\`
Javascript output:

[22:44:53.054] INFO (#47): Calling "readFile" { path: 'package.json' }
{
  "name": "my-project",
  "version": "1.0.0"
}
\`\`\``,
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
        effort: "low",
        summary: "auto",
      },
    }).pipe(Layer.provide(ClientLayer)),
    NodeServices.layer,
  ]),
  NodeRuntime.runMain,
)

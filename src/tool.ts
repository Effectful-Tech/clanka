import { NodeRuntime, NodeServices } from "@effect/platform-node"
import {
  Array,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  pipe,
  Schema,
  Stream,
} from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai"
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

const Tools = Toolkit.make(
  Tool.make("execute", {
    description: "Run javascript code",
    parameters: Schema.Struct({
      script: Schema.String,
    }),
    success: Schema.String,
    dependencies: [CurrentDirectory, TaskCompleteDeferred],
  }),
)

const ToolHandlers = Tools.toLayer(
  Effect.gen(function* () {
    const executor = yield* Executor
    const tools = yield* AgentTools
    return Tools.of({
      execute: Effect.fn("Tools.execute")(function* ({ script }) {
        const cwd = yield* CurrentDirectory
        const deferred = yield* TaskCompleteDeferred
        return yield* pipe(
          executor.execute({
            tools,
            script,
          }),
          Stream.mkString,
          Effect.provideService(CurrentDirectory, cwd),
          Effect.provideService(TaskCompleteDeferred, deferred),
        )
      }),
    })
  }),
).pipe(Layer.provide([AgentToolHandlers, Executor.layer]))

Effect.gen(function* () {
  const ai = yield* LanguageModel.LanguageModel
  const fs = yield* FileSystem.FileSystem
  const renderer = yield* ToolkitRenderer
  const deferred = yield* Deferred.make<string>()
  const tools = yield* Tools

  const agentsMd = yield* fs.readFileString("AGENTS.md")
  let prompt = Prompt.make([
    { role: "user", content: process.argv[2]! },
    {
      role: "user",
      content: `Here is a copy of ./AGENTS.md. ALWAYS follow these instructions when completing the above task:

${agentsMd}`,
    },
  ])

  yield* Effect.gen(function* () {
    while (true) {
      // oxlint-disable-next-line typescript/no-explicit-any
      let responseParts = Array.empty<StreamPart<any>>()
      let hasTools = false
      yield* pipe(
        ai.streamText({ prompt, toolkit: tools }),
        Stream.runForEachArray((parts) => {
          responseParts.push(...parts)
          for (const part of parts) {
            switch (part.type) {
              case "text-delta":
                process.stdout.write(part.delta)
                break
              case "text-end":
                console.log("\n")
                break
              case "reasoning-delta":
                process.stdout.write(part.delta)
                break
              case "reasoning-end":
                console.log("\n")
                break
              case "tool-call":
                hasTools = true
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
            responseParts = []
            return err.isRetryable
          },
        }),
      )
      if (!hasTools) break
      prompt = Prompt.concat(prompt, Prompt.fromResponseParts(responseParts))
    }
  }).pipe(
    Effect.provideService(CurrentDirectory, process.cwd()),
    Effect.provideService(TaskCompleteDeferred, deferred),
    OpenAiLanguageModel.withConfigOverride({
      instructions: `You are a professional software engineer. You are precise, thoughtful and concise. You make changes with care and always do the due diligence to ensure the best possible outcome. You make no mistakes.

- You only add comments when necessary.
- You do the research before making changes.

To do your job, use the "execute" tool to run code that helps you complete the task.

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
[22:44:53.054] INFO (#47): Calling "readFile" { path: 'package.json' }
{
  "name": "my-project",
  "version": "1.0.0"
}
\`\`\``,
    }),
  )
}).pipe(
  Effect.provide([
    ToolHandlers,
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

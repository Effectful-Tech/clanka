/**
 * @since 1.0.0
 */
import {
  Array,
  Data,
  Deferred,
  Effect,
  FileSystem,
  identity,
  Layer,
  Option,
  Path,
  pipe,
  Queue,
  Schema,
  Scope,
  ServiceMap,
  Stream,
} from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai"
import {
  AgentToolHandlers,
  AgentTools,
  CurrentDirectory,
  SubagentContext,
  TaskCompleteDeferred,
} from "./AgentTools.ts"
import { Executor } from "./Executor.ts"
import { ToolkitRenderer } from "./ToolkitRenderer.ts"
import { ProviderName } from "effect/unstable/ai/Model"
import { OpenAiLanguageModel } from "@effect/ai-openai"
import { type StreamPart } from "effect/unstable/ai/Response"
import type { ChildProcessSpawner } from "effect/unstable/process"

/**
 * @since 1.0.0
 * @category Models
 */
export interface Agent {
  readonly output: Stream.Stream<Output, AgentFinished>
}

/**
 * A layer that provides most of the common services needed to run an agent.
 *
 * @since 1.0.0
 * @category Services
 */
export const layerServices: Layer.Layer<
  Tool.HandlersFor<typeof AgentTools.tools> | Executor | ToolkitRenderer,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> = Layer.mergeAll(AgentToolHandlers, Executor.layer, ToolkitRenderer.layer)

/**
 * Start an agent in the given directory with the given prompt and tools.
 *
 * @since 1.0.0
 * @category Constructors
 */
export const make: <Tools extends Record<string, Tool.Any> = {}>(options: {
  /** The working directory to run the agent in */
  readonly directory: string
  /** The prompt to use for the agent */
  readonly prompt: Prompt.RawInput
  /** Additional system instructions to provide to the agent */
  readonly system?: string | undefined
  /** Additional tools to provide to the agent */
  readonly tools?: Toolkit.Toolkit<Tools> | undefined
}) => Effect.Effect<
  Agent,
  never,
  | Scope.Scope
  | FileSystem.FileSystem
  | Path.Path
  | Executor
  | LanguageModel.LanguageModel
  | ProviderName
  | ToolkitRenderer
  | Tool.HandlersFor<Tools>
  | Tool.HandlersFor<typeof AgentTools.tools>
  | Tool.HandlerServices<Tools[keyof Tools]>
> = Effect.fnUntraced(function* (options: {
  /** The working directory to run the agent in */
  readonly directory: string
  /** The prompt to use for the agent */
  readonly prompt: Prompt.RawInput
  /** Additional system instructions to provide to the agent */
  readonly system?: string | undefined
  /** Additional tools to provide to the agent */
  readonly tools?: Toolkit.Toolkit<{}> | undefined
}) {
  const ai = yield* LanguageModel.LanguageModel
  const provider = yield* ProviderName
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const executor = yield* Executor
  const allTools = Toolkit.merge(AgentTools, options.tools ?? Toolkit.empty)
  const tools = yield* allTools
  const services = yield* Effect.services<Tool.HandlerServices<{}>>()

  let system = yield* generateSystem(allTools)
  if (options.system) {
    system += `\n${options.system}`
  }
  const withSystemPrompt = OpenAiLanguageModel.withConfigOverride({
    instructions: system,
  })

  const agentsMd = yield* pipe(
    fs.readFileString(pathService.resolve(options.directory, "AGENTS.md")),
    Effect.option,
  )

  let subagentId = 0

  const spawn: (prompt: Prompt.Prompt) => Stream.Stream<Output, AgentFinished> =
    Effect.fnUntraced(function* (prompt) {
      const deferred = yield* Deferred.make<string>()
      const output = yield* Queue.make<Output, AgentFinished>()

      const taskServices = SubagentContext.serviceMap({
        spawn: ({ prompt }) => {
          let id = ++subagentId
          return spawn(Prompt.make(prompt)).pipe(
            Stream.broadcast({
              capacity: "unbounded",
            }),
            Effect.flatMap((stream) => {
              Queue.offerUnsafe(
                output,
                new SubagentPart({ id, output: stream }),
              )
              return Stream.runDrain(stream)
            }),
            Effect.scoped,
            Effect.as(""),
            Effect.catch((e) => Effect.succeed(e.summary)),
          )
        },
      }).pipe(
        ServiceMap.add(CurrentDirectory, options.directory),
        ServiceMap.add(TaskCompleteDeferred, deferred),
      )

      prompt = Prompt.concat(
        prompt,
        agentsMd.pipe(
          Option.map((md) =>
            Prompt.make(`Here is a copy of ./AGENTS.md. ALWAYS follow these instructions when completing the above task:

${md}`),
          ),
          Option.getOrElse(() => Prompt.empty),
        ),
      )

      if (provider !== "openai") {
        prompt = Prompt.setSystem(prompt, system)
      }

      let currentScript = ""
      yield* Effect.gen(function* () {
        while (true) {
          if (currentScript.length > 0) {
            Queue.offerUnsafe(
              output,
              new ScriptStart({ script: currentScript }),
            )
            const result = yield* pipe(
              executor.execute({
                tools,
                script: currentScript,
              }),
              Stream.mkString,
            )
            Queue.offerUnsafe(output, new ScriptEnd({ output: result }))
            prompt = Prompt.concat(prompt, `Javascript output:\n\n${result}`)
            currentScript = ""
          }

          if (Deferred.isDoneUnsafe(deferred)) {
            yield* Queue.fail(
              output,
              new AgentFinished({ summary: yield* Deferred.await(deferred) }),
            )
            return
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
                    currentScript = ""
                    break
                  case "text-delta":
                    currentScript += part.delta
                    break
                  case "reasoning-start":
                    break
                  case "reasoning-delta":
                    // process.stdout.write(part.delta)
                    break
                  case "reasoning-end":
                    // console.log("\n")
                    break
                  case "finish":
                    // console.log("Tokens used:", part.usage, "\n")
                    break
                }
              }
              return Effect.void
            }),
            Effect.retry({
              while: (err) => {
                response = []
                return err.isRetryable
              },
            }),
            provider === "openai" ? withSystemPrompt : identity,
          )
          prompt = Prompt.concat(prompt, Prompt.fromResponseParts(response))
          currentScript = currentScript.trim()
        }
      }).pipe(
        Effect.provideServices(taskServices),
        Effect.provideServices(services),
        Effect.forkScoped,
      )

      return Stream.fromQueue(output)
    }, Stream.unwrap)

  const output = yield* spawn(Prompt.make(options.prompt)).pipe(
    Stream.broadcast({
      capacity: "unbounded",
    }),
  )

  return identity<Agent>({
    output,
  })
  // oxlint-disable-next-line typescript/no-explicit-any
}) as any

// oxlint-disable-next-line typescript/no-explicit-any
const generateSystem = Effect.fn(function* (tools: Toolkit.Toolkit<any>) {
  const renderer = yield* ToolkitRenderer

  return `# Who you are

You are a professional software engineer. You are precise, thoughtful and concise. You make changes with care and always do the due diligence to ensure the best possible outcome. You make no mistakes.

# Completing the task

To complete the task respond with javascript code that will be executed for you.

- Do not add any markdown formatting, just code.
- Use \`console.log\` to print any output you need.
- Top level await is supported.
- **Prefer using the functions provided** over the bash tool

You have the following functions available to you:

\`\`\`ts
${renderer.render(tools)}

declare const fetch: typeof globalThis.fetch
\`\`\`

Here is how you would read a file:

\`\`\`
const content = await readFile({
  path: "package.json",
  startLine: 1,
  endLine: 10,
})
console.log(JSON.parse(content))
\`\`\`

And the output would look like this:

\`\`\`
Javascript output:

[22:44:53.054] INFO (#47): Calling "readFile" { path: 'package.json' }
{
  "name": "my-project",
  "version": "1.0.0"
}
\`\`\`

# Guidelines

- Use the current state of the codebase to inform your decisions. Don't look at git history unless explicity asked to.
- Only add comments when necessary.
- Repect the users AGENTS.md file and ALWAYS follow the instructions in it.
`
})

/**
 * @since 1.0.0
 * @category Output
 */
export class ReasoningStart extends Schema.TaggedClass<ReasoningStart>()(
  "ReasoningStart",
  {},
) {}

/**
 * @since 1.0.0
 * @category Output
 */
export class ReasoningDelta extends Schema.TaggedClass<ReasoningDelta>()(
  "ReasoningDelta",
  {
    delta: Schema.String,
  },
) {}

/**
 * @since 1.0.0
 * @category Output
 */
export class ReasoningEnd extends Schema.TaggedClass<ReasoningEnd>()(
  "ReasoningEnd",
  {},
) {}

/**
 * @since 1.0.0
 * @category Output
 */
export class ScriptStart extends Schema.TaggedClass<ScriptStart>()(
  "ScriptStart",
  {
    script: Schema.String,
  },
) {}

/**
 * @since 1.0.0
 * @category Output
 */
export class ScriptEnd extends Schema.TaggedClass<ScriptEnd>()("ScriptEnd", {
  output: Schema.String,
}) {}

/**
 * @since 1.0.0
 * @category Output
 */
export class AgentFinished extends Schema.TaggedErrorClass<AgentFinished>()(
  "AgentFinished",
  {
    summary: Schema.String,
  },
) {}

/**
 * @since 1.0.0
 * @category Output
 */
export const OutputPart = Schema.Union([
  ReasoningStart,
  ReasoningDelta,
  ReasoningEnd,
  ScriptStart,
  ScriptEnd,
])

/**
 * @since 1.0.0
 * @category Output
 */
export type OutputPart = typeof OutputPart.Type

/**
 * @since 1.0.0
 * @category Output
 */
export class SubagentPart extends Data.TaggedError("SubagentPart")<{
  id: number
  output: Stream.Stream<Output, AgentFinished>
}> {}

/**
 * @since 1.0.0
 * @category Output
 */
export type Output = OutputPart | SubagentPart

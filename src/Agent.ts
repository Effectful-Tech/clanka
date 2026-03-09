/**
 * @since 1.0.0
 */
import {
  Array,
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
import { ModelName, ProviderName } from "effect/unstable/ai/Model"
import { OpenAiLanguageModel } from "@effect/ai-openai"
import { type StreamPart } from "effect/unstable/ai/Response"
import type { ChildProcessSpawner } from "effect/unstable/process"

/**
 * @since 1.0.0
 * @category Models
 */
export interface Agent {
  readonly output: Stream.Stream<Output, AgentFinished>

  /**
   * Send a message to the agent to steer its behavior. This is useful for
   * providing feedback or new instructions while the agent is running.
   *
   * The effect will only complete once the message has been sent.
   * Interrupting the effect will withdraw the message, so it will not be sent
   * to the agent.
   */
  steer(message: string): Effect.Effect<void>
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
export const make: <
  Tools extends Record<string, Tool.Any> = {},
  SE = never,
  SR = never,
>(options: {
  /** The working directory to run the agent in */
  readonly directory: string
  /** The prompt to use for the agent */
  readonly prompt: Prompt.RawInput
  /** Additional system instructions to provide to the agent */
  readonly system?: string | undefined
  /** Additional tools to provide to the agent */
  readonly tools?: Toolkit.Toolkit<Tools> | undefined
  /** Layer to use for subagents */
  readonly subagentModel?:
    | Layer.Layer<LanguageModel.LanguageModel | ProviderName, SE, SR>
    | undefined
}) => Effect.Effect<
  Agent,
  never,
  | Scope.Scope
  | FileSystem.FileSystem
  | Path.Path
  | Executor
  | LanguageModel.LanguageModel
  | ProviderName
  | ModelName
  | ToolkitRenderer
  | Tool.HandlersFor<Tools>
  | Tool.HandlersFor<typeof AgentTools.tools>
  | Tool.HandlerServices<Tools[keyof Tools]>
  | SR
> = Effect.fnUntraced(function* (options: {
  readonly directory: string
  readonly prompt: Prompt.RawInput
  readonly system?: string | undefined
  readonly tools?: Toolkit.Toolkit<{}> | undefined
  readonly subagentModel?:
    | Layer.Layer<LanguageModel.LanguageModel | ProviderName | ModelName>
    | undefined
}) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const executor = yield* Executor
  const allTools = Toolkit.merge(AgentTools, options.tools ?? Toolkit.empty)
  const tools = yield* allTools
  const services = yield* Effect.services<
    | Tool.HandlerServices<{}>
    | LanguageModel.LanguageModel
    | ProviderName
    | ModelName
  >()
  const pendingMessages = new Set<{
    readonly message: string
    readonly resume: (effect: Effect.Effect<void>) => void
  }>()

  let system = yield* generateSystem(allTools)

  const agentsMd = yield* pipe(
    fs.readFileString(pathService.resolve(options.directory, "AGENTS.md")),
    Effect.option,
  )

  if (Option.isSome(agentsMd)) {
    system += `
# AGENTS.md

The following instructions are in AGENTS.md in the current directory. ALWAYS follow these instructions when completing tasks:

${agentsMd.value}
`
  }

  if (options.system) {
    system += `\n${options.system}\n`
  }

  const withSystemPrompt = OpenAiLanguageModel.withConfigOverride({
    store: false,
    instructions: system,
  })

  let agentCounter = 0

  const outputBuffer = new Map<number, Array<Output>>()
  let currentOutputAgent: number | null = null

  const spawn: (
    agentId: number,
    prompt: Prompt.Prompt,
  ) => Stream.Stream<
    Output,
    AgentFinished,
    LanguageModel.LanguageModel | ProviderName
  > = Effect.fnUntraced(function* (agentId, prompt) {
    const ai = yield* LanguageModel.LanguageModel
    const provider = yield* ProviderName
    const deferred = yield* Deferred.make<string>()
    const output = yield* Queue.make<Output, AgentFinished>()

    function maybeSend(agentId: number, part: Output, lock = false) {
      if (currentOutputAgent === null || currentOutputAgent === agentId) {
        Queue.offerUnsafe(output, part)
        if (lock) {
          currentOutputAgent = agentId
        }
        return true
      }
      const state = outputBuffer.get(agentId) ?? []
      state.push(part)
      return false
    }

    function flushBuffer() {
      currentOutputAgent = null
      for (const [id, state] of outputBuffer) {
        outputBuffer.delete(id)
        Queue.offerAllUnsafe(output, state)
        const lastPart = state[state.length - 1]!
        if (lastPart._tag === "ReasoningDelta") {
          currentOutputAgent = id
          break
        }
      }
    }

    const taskServices = SubagentContext.serviceMap({
      spawn: ({ prompt }) => {
        let id = agentCounter++
        const stream = spawn(
          id,
          Prompt.make(`You have been spawned using "subagent" to complete the following task:

${prompt}`),
        )
        return Effect.gen(function* () {
          const provider = yield* ProviderName
          const model = yield* ModelName
          Queue.offerUnsafe(
            output,
            new SubagentStart({ id, prompt, model, provider }),
          )
          return yield* stream.pipe(
            Stream.runForEachArray((parts) => {
              for (const part of parts) {
                switch (part._tag) {
                  case "SubagentStart":
                  case "SubagentComplete":
                  case "SubagentPart":
                    break

                  default:
                    Queue.offerUnsafe(output, new SubagentPart({ id, part }))
                    break
                }
              }
              return Effect.void
            }),
            Effect.as(""),
            Effect.catch((finished) => {
              Queue.offerUnsafe(
                output,
                new SubagentComplete({ id, summary: finished.summary }),
              )
              return Effect.succeed(finished.summary)
            }),
          )
        }).pipe(
          options.subagentModel
            ? Effect.provide(Layer.orDie(options.subagentModel))
            : Effect.provideServices(services),
        )
      },
    }).pipe(
      ServiceMap.add(CurrentDirectory, options.directory),
      ServiceMap.add(TaskCompleteDeferred, deferred),
    )

    if (provider !== "openai") {
      prompt = Prompt.setSystem(prompt, system)
    }

    let currentScript = ""
    yield* Effect.gen(function* () {
      while (true) {
        if (currentScript.length > 0) {
          maybeSend(agentId, new ScriptStart({ script: currentScript }))
          const result = yield* pipe(
            executor.execute({
              tools,
              script: currentScript,
            }),
            Stream.mkString,
          )
          maybeSend(agentId, new ScriptEnd({ output: result }))
          prompt = Prompt.concat(prompt, [
            { role: "assistant", content: `Javascript output:\n\n${result}` },
          ])
          currentScript = ""
        }

        if (Deferred.isDoneUnsafe(deferred)) {
          yield* Queue.fail(
            output,
            new AgentFinished({ summary: yield* Deferred.await(deferred) }),
          )
          return
        }

        if (pendingMessages.size > 0) {
          prompt = Prompt.concat(
            prompt,
            Array.Array.from(pendingMessages, ({ message, resume }) => {
              resume(Effect.void)
              return {
                role: "user",
                content: message,
              }
            }),
          )
          pendingMessages.clear()
        }

        let response = Array.empty<StreamPart<{}>>()
        let reasoningStarted = false
        let hadReasoningDelta = false
        yield* pipe(
          ai.streamText({ prompt }),
          Stream.takeUntil((part) => {
            if (part.type === "text-end" && currentScript.trim().length > 0) {
              return true
            }
            if (part.type === "reasoning-end" && pendingMessages.size > 0) {
              return true
            }
            return false
          }),
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
                  reasoningStarted = true
                  break
                case "reasoning-delta":
                  hadReasoningDelta = true
                  if (reasoningStarted) {
                    reasoningStarted = false
                    maybeSend(agentId, new ReasoningStart(), true)
                  }
                  maybeSend(agentId, new ReasoningDelta({ delta: part.delta }))
                  break
                case "reasoning-end":
                  reasoningStarted = false
                  if (hadReasoningDelta) {
                    hadReasoningDelta = false
                    const sent = maybeSend(agentId, new ReasoningEnd())
                    if (sent) flushBuffer()
                  }
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

  const output = yield* spawn(agentCounter++, Prompt.make(options.prompt)).pipe(
    Stream.broadcast({
      capacity: "unbounded",
    }),
  )

  return identity<Agent>({
    output,
    steer: (message) =>
      Effect.callback((resume) => {
        const entry = { message, resume }
        pendingMessages.add(entry)
        return Effect.sync(() => pendingMessages.delete(entry))
      }),
  })
  // oxlint-disable-next-line typescript/no-explicit-any
}) as any

// oxlint-disable-next-line typescript/no-explicit-any
const generateSystem = Effect.fn(function* (tools: Toolkit.Toolkit<any>) {
  const renderer = yield* ToolkitRenderer

  return `You are a professional software engineer. You are precise, thoughtful and concise. You make changes with care and always do the due diligence to ensure the best possible outcome. You make no mistakes.

To do your job, only respond with javascript code that will be executed for you.

- Do not add any markdown formatting, just code.
- Use \`console.log\` to print any output you need.
- Top level await is supported.
- **Prefer using the functions provided** over the bash tool

**When you have completed your task**, call the "taskComplete" function with the final output.

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
- Use the "subagent" tool to delegate large tasks / exploration. Run multiple subagents in parallel with Promise.all
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
export class SubagentStart extends Schema.TaggedClass<SubagentStart>()(
  "SubagentStart",
  {
    id: Schema.Number,
    prompt: Schema.String,
    model: Schema.String,
    provider: Schema.String,
  },
) {
  get modelAndProvider() {
    return `${this.provider}/${this.model}`
  }
}

/**
 * @since 1.0.0
 * @category Output
 */
export class SubagentComplete extends Schema.TaggedClass<SubagentComplete>()(
  "SubagentComplete",
  {
    id: Schema.Number,
    summary: Schema.String,
  },
) {}

export type ContentPart =
  | ReasoningStart
  | ReasoningDelta
  | ReasoningEnd
  | ScriptStart
  | ScriptEnd

export const ContentPart = Schema.Union([
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
export class SubagentPart extends Schema.TaggedClass<SubagentPart>()(
  "SubagentPart",
  {
    id: Schema.Number,
    part: ContentPart,
  },
) {}

/**
 * @since 1.0.0
 * @category Output
 */
export type Output =
  | ContentPart
  | SubagentStart
  | SubagentComplete
  | SubagentPart

/**
 * @since 1.0.0
 * @category Output
 */
export const Output = Schema.Union([
  ReasoningStart,
  ReasoningDelta,
  ReasoningEnd,
  ScriptStart,
  ScriptEnd,
  SubagentStart,
  SubagentComplete,
  SubagentPart,
])

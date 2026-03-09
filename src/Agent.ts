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
import {
  AiError,
  LanguageModel,
  Prompt,
  Tool,
  Toolkit,
} from "effect/unstable/ai"
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
import { type StreamPart } from "effect/unstable/ai/Response"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { extractScript } from "./ScriptExtraction.ts"

/**
 * @since 1.0.0
 * @category Models
 */
export interface Agent {
  readonly output: Stream.Stream<Output, AgentFinished | AiError.AiError>

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
  const renderer = yield* ToolkitRenderer
  const allTools = Toolkit.merge(AgentTools, options.tools ?? Toolkit.empty)
  const allToolsDts = renderer.render(allTools)
  const tools = yield* allTools
  const singleTool = yield* SingleTools.asEffect().pipe(
    Effect.provide(SingleToolHandlers),
  )
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

  const agentsMd = yield* pipe(
    fs.readFileString(pathService.resolve(options.directory, "AGENTS.md")),
    Effect.option,
  )

  let agentCounter = 0

  const outputBuffer = new Map<number, Array<Output>>()
  let currentOutputAgent: number | null = null

  const spawn: (
    agentId: number,
    prompt: Prompt.Prompt,
  ) => Stream.Stream<
    Output,
    AgentFinished | AiError.AiError,
    LanguageModel.LanguageModel | ProviderName
  > = Effect.fnUntraced(function* (agentId, prompt) {
    const ai = yield* LanguageModel.LanguageModel
    const modelConfig = yield* AgentModelConfig
    const singleToolMode = modelConfig.supportsNoTools !== false
    const deferred = yield* Deferred.make<string>()
    const output = yield* Queue.make<Output, AgentFinished | AiError.AiError>()

    let system = generateSystem(allToolsDts, !singleToolMode)

    if (Option.isSome(agentsMd)) {
      system += `
# AGENTS.md

The following instructions are from ./AGENTS.md in the current directory.
You do not need to read this file again.

**ALWAYS follow these instructions when completing tasks**:

<!-- AGENTS.md start -->
${agentsMd.value}
<!-- AGENTS.md end -->
`
    }

    if (options.system) {
      system += `\n${options.system}\n`
    }

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
            Effect.catchTag("AgentFinished", (finished) => {
              Queue.offerUnsafe(
                output,
                new SubagentComplete({ id, summary: finished.summary }),
              )
              return Effect.succeed(finished.summary)
            }),
            Effect.orDie,
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

    const executeScript = Effect.fnUntraced(function* (script: string) {
      maybeSend(agentId, new ScriptEnd())
      const output = yield* pipe(
        executor.execute({ tools, script }),
        Stream.mkString,
        Effect.provideServices(taskServices),
      )
      maybeSend(agentId, new ScriptOutput({ output }))
      return output
    })

    if (!modelConfig.systemPromptTransform) {
      prompt = Prompt.setSystem(prompt, system)
    }

    let currentScript = ""
    yield* Effect.gen(function* () {
      while (true) {
        if (!singleToolMode && currentScript.length > 0) {
          currentScript = extractScript(currentScript)
          const result = yield* executeScript(currentScript)
          prompt = Prompt.concat(prompt, [
            {
              role: modelConfig.supportsAssistantPrefill ? "assistant" : "user",
              content: `Javascript output:\n\n${result}`,
            },
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

        // oxlint-disable-next-line typescript/no-explicit-any
        let response = Array.empty<StreamPart<any>>()
        let reasoningStarted = false
        let hadReasoningDelta = false
        yield* pipe(
          ai.streamText(
            singleToolMode ? { prompt, toolkit: singleTool } : { prompt },
          ),
          Stream.takeUntil((part) => {
            if (
              !singleToolMode &&
              part.type === "text-end" &&
              currentScript.trim().length > 0
            ) {
              return true
            }
            if (
              (part.type === "text-end" || part.type === "reasoning-end") &&
              pendingMessages.size > 0
            ) {
              return true
            }
            return false
          }),
          Stream.runForEachArray((parts) => {
            response.push(...parts)

            for (const part of parts) {
              switch (part.type) {
                case "text-start":
                  if (singleToolMode) {
                    reasoningStarted = true
                    break
                  }
                  currentScript = ""
                  break
                case "text-delta": {
                  if (singleToolMode) {
                    hadReasoningDelta = true
                    if (reasoningStarted) {
                      reasoningStarted = false
                      maybeSend(agentId, new ReasoningStart(), true)
                    }
                    maybeSend(
                      agentId,
                      new ReasoningDelta({ delta: part.delta }),
                    )
                    break
                  }
                  if (currentScript === "" && part.delta.length > 0) {
                    maybeSend(agentId, new ScriptStart(), true)
                  }
                  maybeSend(agentId, new ScriptDelta({ delta: part.delta }))
                  currentScript += part.delta
                  break
                }
                case "text-end": {
                  if (singleToolMode) {
                    reasoningStarted = false
                    if (hadReasoningDelta) {
                      hadReasoningDelta = false
                      const sent = maybeSend(agentId, new ReasoningEnd())
                      if (sent) flushBuffer()
                    }
                  }
                  break
                }
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
          modelConfig.systemPromptTransform
            ? (effect) => modelConfig.systemPromptTransform!(system, effect)
            : identity,
        )
        prompt = Prompt.concat(prompt, Prompt.fromResponseParts(response))
        currentScript = currentScript.trim()
      }
    }).pipe(
      Effect.provideServices(
        taskServices.pipe(
          ServiceMap.add(ScriptExecutor, (script) => {
            maybeSend(agentId, new ScriptStart())
            maybeSend(agentId, new ScriptDelta({ delta: script }))
            return executeScript(script)
          }),
        ),
      ),
      Effect.provideServices(services),
      Effect.catchCause((cause) => Queue.failCause(output, cause)),
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

const generateSystem = (
  // oxlint-disable-next-line typescript/no-explicit-any
  toolsDts: string,
  multi: boolean,
) => {
  const toolMd = multi
    ? generateSystemMulti(toolsDts)
    : generateSystemSingle(toolsDts)

  return `You are a professional software engineer. You are precise, thoughtful and concise. You make changes with care and always do the due diligence to ensure the best possible outcome. You make no mistakes.

${toolMd}

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
}

// oxlint-disable-next-line typescript/no-explicit-any
const generateSystemMulti = (toolsDts: string) => {
  return `From now on only respond with javascript code that will be executed for you.

- Use \`console.log\` to print any output you need.
- Top level await is supported.
- **Prefer using the functions provided** over the bash tool

**When you have completed your task**, call the "taskComplete" function with the final output.

You have the following functions available to you:

\`\`\`ts
${toolsDts}

declare const fetch: typeof globalThis.fetch
\`\`\``
}

// oxlint-disable-next-line typescript/no-explicit-any
const generateSystemSingle = (toolsDts: string) => {
  return `Use the "execute" tool to run javascript code to do your work.

- Use \`console.log\` to print any output you need.
- Top level await is supported.
- **Prefer using the functions provided** over the bash tool

You have the following functions available to you:

\`\`\`ts
${toolsDts}

declare const fetch: typeof globalThis.fetch
\`\`\``
}

class ScriptExecutor extends ServiceMap.Service<
  ScriptExecutor,
  (script: string) => Effect.Effect<string>
>()("clanka/Agent/ScriptExecutor") {}

const SingleTools = Toolkit.make(
  Tool.make("execute", {
    description: "Execute javascript code and return the output",
    parameters: Schema.Struct({
      script: Schema.String,
    }),
    success: Schema.String,
    dependencies: [ScriptExecutor],
  }),
)
const SingleToolHandlers = SingleTools.toLayer({
  execute: Effect.fnUntraced(function* ({ script }) {
    const execute = yield* ScriptExecutor
    return yield* execute(script)
  }),
})

/**
 * @since 1.0.0
 * @category System prompts
 */
export class AgentModelConfig extends ServiceMap.Reference<{
  readonly systemPromptTransform?: <A, E, R>(
    system: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  readonly supportsAssistantPrefill?: boolean | undefined
  readonly supportsNoTools?: boolean | undefined
}>("clanka/Agent/SystemPromptTransform", {
  defaultValue: () => ({}),
}) {
  static readonly layer = (options: typeof AgentModelConfig.Service) =>
    Layer.succeed(AgentModelConfig, options)
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
  {},
) {}

/**
 * @since 1.0.0
 * @category Output
 */
export class ScriptDelta extends Schema.TaggedClass<ScriptDelta>()(
  "ScriptDelta",
  {
    delta: Schema.String,
  },
) {}

/**
 * @since 1.0.0
 * @category Output
 */
export class ScriptEnd extends Schema.TaggedClass<ScriptEnd>()(
  "ScriptEnd",
  {},
) {}

/**
 * @since 1.0.0
 * @category Output
 */
export class ScriptOutput extends Schema.TaggedClass<ScriptOutput>()(
  "ScriptOutput",
  {
    output: Schema.String,
  },
) {}

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
  | ScriptDelta
  | ScriptEnd
  | ScriptOutput

export const ContentPart = Schema.Union([
  ReasoningStart,
  ReasoningDelta,
  ReasoningEnd,
  ScriptStart,
  ScriptDelta,
  ScriptEnd,
  ScriptOutput,
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
  ScriptDelta,
  ScriptEnd,
  ScriptOutput,
  SubagentStart,
  SubagentComplete,
  SubagentPart,
])

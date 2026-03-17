/**
 * @since 1.0.0
 */
import * as Model from "effect/unstable/ai/Model"
import type * as Response from "effect/unstable/ai/Response"
import * as AgentExecutor from "./AgentExecutor.ts"
import { stripWrappingCodeFence } from "./ScriptExtraction.ts"
import type * as Path from "effect/Path"
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import type {
  CurrentDirectory,
  SubagentExecutor,
  TaskCompleter,
} from "./AgentTools.ts"
import type * as FileSystem from "effect/FileSystem"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import type * as Scope from "effect/Scope"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as AiError from "effect/unstable/ai/AiError"
import * as ServiceMap from "effect/ServiceMap"
import * as Option from "effect/Option"
import { identity, pipe } from "effect/Function"
import * as MutableRef from "effect/MutableRef"
import * as Queue from "effect/Queue"
import * as Array from "effect/Array"
import * as Schema from "effect/Schema"
import * as Layer from "effect/Layer"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import * as Semaphore from "effect/Semaphore"
import * as Schedule from "effect/Schedule"

/**
 * @since 1.0.0
 * @category Models
 */
export type TypeId = "~clanka/Agent"

/**
 * @since 1.0.0
 * @category Models
 */
export const TypeId: TypeId = "~clanka/Agent"

/**
 * @since 1.0.0
 * @category Models
 */
export interface Agent {
  readonly [TypeId]: TypeId

  /**
   * Send a prompt to the agent and receive a stream of output.
   */
  send(options: {
    /**
     * The prompt to send to the agent.
     */
    readonly prompt: Prompt.RawInput
    /**
     * Provide additional system instructions, or a function that generates
     * system instructions based on the tool instructions
     */
    readonly system?:
      | string
      | ((options: {
          readonly toolInstructions: string
          readonly agentsMd: string
        }) => string)
      | undefined
  }): Effect.Effect<
    Stream.Stream<Output, AgentFinished | AiError.AiError>,
    never,
    | Scope.Scope
    | LanguageModel.LanguageModel
    | Model.ProviderName
    | Model.ModelName
    | SubagentModel
  >

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
 * @since 1.0.0
 * @category Service
 */
export const Agent = ServiceMap.Service<Agent>("clanka/Agent")

/**
 * @since 1.0.0
 * @category Constructors
 */
export const make = Effect.gen(function* (): Effect.fn.Return<
  Agent,
  never,
  Scope.Scope | AgentExecutor.AgentExecutor
> {
  const executor = yield* AgentExecutor.AgentExecutor

  const singleTool = yield* SingleTools.asEffect().pipe(
    Effect.provide(SingleToolHandlers),
  )
  const capabilities = yield* executor.capabilities

  const pendingMessages = new Set<{
    readonly message: string
    readonly resume: (effect: Effect.Effect<void>) => void
  }>()

  const agentsMd = Option.map(
    capabilities.agentsMd,
    (content) => `# AGENTS.md

The following instructions are from ./AGENTS.md in the current directory.
You do not need to read this file again.

**ALWAYS follow these instructions when completing tasks**:

<!-- AGENTS.md start -->
${content}
<!-- AGENTS.md end -->`,
  )

  let agentCounter = 0

  const outputBuffer = new Map<number, Array<Output>>()
  let currentOutputAgent: number | null = null

  let history = MutableRef.make(Prompt.empty)

  const spawn: (opts: {
    readonly agentId: number
    readonly prompt: Prompt.Prompt
    readonly system?:
      | string
      | ((options: {
          readonly toolInstructions: string
          readonly agentsMd: string
        }) => string)
      | undefined
    readonly disableHistory?: boolean | undefined
  }) => Stream.Stream<
    Output,
    AgentFinished | AiError.AiError,
    | LanguageModel.LanguageModel
    | Model.ProviderName
    | Model.ModelName
    | SubagentModel
  > = Effect.fnUntraced(function* (opts) {
    const agentId = opts.agentId
    const ai = yield* LanguageModel.LanguageModel
    const subagentModel = yield* SubagentModel
    const modelConfig = yield* AgentModelConfig
    let finalSummary = Option.none<string>()

    const output = yield* Queue.make<Output, AgentFinished | AiError.AiError>()
    let outputTokens = 0
    const prompt = opts.disableHistory ? MutableRef.make(Prompt.empty) : history

    MutableRef.update(prompt, Prompt.concat(opts.prompt))

    const generateSystem =
      typeof opts.system === "function" ? opts.system : defaultSystem

    const toolInstructions = generateSystemTools(capabilities)
    let system = generateSystem({
      toolInstructions,
      agentsMd: Option.getOrElse(agentsMd, () => ""),
    })
    if (typeof opts.system === "string") {
      system += `\n${opts.system}\n`
    }
    console.log("Generated system prompt:", system)

    function maybeSend(options: {
      readonly agentId: number
      readonly part: Output
      readonly acquire?: boolean
      readonly release?: boolean
    }) {
      if (currentOutputAgent === null || currentOutputAgent === opts.agentId) {
        Queue.offerUnsafe(output, options.part)
        if (options.acquire) {
          currentOutputAgent = opts.agentId
        }
        if (options.release) {
          currentOutputAgent = null
          for (const [id, state] of outputBuffer) {
            outputBuffer.delete(id)
            Queue.offerAllUnsafe(output, state)
            const lastPart = state[state.length - 1]!
            if (
              lastPart._tag === "ScriptDelta" ||
              lastPart._tag === "ReasoningDelta"
            ) {
              currentOutputAgent = id
              break
            }
          }
        }
        return
      }
      let state = outputBuffer.get(opts.agentId)
      if (!state) {
        state = []
        outputBuffer.set(opts.agentId, state)
      }
      state.push(options.part)
      return
    }

    const spawnSubagent = Effect.fnUntraced(
      function* (prompt: string) {
        let id = agentCounter++
        const stream = spawn({
          agentId: id,
          prompt: Prompt.make(prompt),
          system: opts.system,
          disableHistory: true,
        })
        const provider = yield* Model.ProviderName
        const model = yield* Model.ModelName
        maybeSend({
          agentId: opts.agentId,
          part: new SubagentStart({ id, prompt, model, provider }),
          release: true,
        })
        return yield* stream.pipe(
          Stream.runForEachArray((parts) => {
            for (const part of parts) {
              switch (part._tag) {
                case "AgentStart":
                  break
                case "SubagentStart":
                case "SubagentComplete":
                case "SubagentPart":
                  Queue.offerUnsafe(output, part)
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
      },
      Effect.provide(subagentModel),
      Effect.provideService(SubagentModel, subagentModel),
    )

    const executeScript = Effect.fnUntraced(function* (script: string) {
      maybeSend({ agentId, part: new ScriptEnd(), release: true })
      const normalizedScript = stripWrappingCodeFence(script)
      const output = yield* pipe(
        executor.execute({
          script: normalizedScript,
          onSubagent: spawnSubagent,
          onTaskComplete: (summary) =>
            Effect.sync(() => {
              finalSummary = Option.some(summary)
            }),
        }),
        Stream.mkString,
      )
      maybeSend({ agentId, part: new ScriptOutput({ output }) })
      return output
    })

    if (!modelConfig.systemPromptTransform) {
      MutableRef.update(prompt, Prompt.setSystem(system))
    }

    yield* Effect.gen(function* () {
      while (true) {
        if (Option.isSome(finalSummary)) {
          yield* Queue.fail(
            output,
            new AgentFinished({ summary: finalSummary.value }),
          )
          return
        }

        if (pendingMessages.size > 0) {
          MutableRef.update(
            prompt,
            Prompt.concat(
              Array.Array.from(pendingMessages, ({ message, resume }) => {
                resume(Effect.void)
                return {
                  role: "user",
                  content: message,
                }
              }),
            ),
          )
          pendingMessages.clear()
        }

        // oxlint-disable-next-line typescript/no-explicit-any
        let response = Array.empty<Response.StreamPart<any>>()
        let reasoningStarted = false
        let hadReasoningDelta = false
        yield* pipe(
          ai.streamText({ prompt: prompt.current, toolkit: singleTool }),
          Stream.takeUntil((part) => {
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
                case "reasoning-start":
                  reasoningStarted = true
                  break
                case "text-delta":
                case "reasoning-delta":
                  hadReasoningDelta = true
                  if (reasoningStarted) {
                    reasoningStarted = false
                    maybeSend({
                      agentId,
                      part: new ReasoningStart(),
                      acquire: true,
                    })
                  }
                  maybeSend({
                    agentId,
                    part: new ReasoningDelta({ delta: part.delta }),
                  })
                  break
                case "text-end":
                case "reasoning-end":
                  reasoningStarted = false
                  if (hadReasoningDelta) {
                    hadReasoningDelta = false
                    maybeSend({
                      agentId,
                      part: new ReasoningEnd(),
                      release: true,
                    })
                  }
                  break
                case "finish":
                  const usage = part.usage
                  if (usage.outputTokens.total !== undefined) {
                    outputTokens += usage.outputTokens.total
                  }
                  if (usage.inputTokens.total !== undefined) {
                    maybeSend({
                      agentId,
                      part: new Usage({
                        inputTokens: usage.inputTokens.total,
                        outputTokens,
                      }),
                    })
                  }
                  break
              }
            }
            return Effect.void
          }),
          Effect.retry({
            while: (err) => {
              response = []
              if (err.isRetryable) {
                maybeSend({ agentId, part: new ErrorRetry({ error: err }) })
              }
              return err.isRetryable
            },
            schedule: retryPolicy,
          }),
          modelConfig.systemPromptTransform
            ? (effect) => modelConfig.systemPromptTransform!(system, effect)
            : identity,
        )
        MutableRef.update(
          prompt,
          Prompt.concat(Prompt.fromResponseParts(response)),
        )
      }
    }).pipe(
      Effect.provideService(ScriptExecutor, (script) => {
        maybeSend({ agentId, part: new ScriptStart() })
        maybeSend({ agentId, part: new ScriptDelta({ delta: script }) })
        return executeScript(script)
      }),
      Effect.catchCause((cause) => Queue.failCause(output, cause)),
      Effect.forkScoped,
    )

    yield* Queue.offer(
      output,
      new AgentStart({
        id: opts.agentId,
        prompt: opts.prompt,
        provider: yield* Model.ProviderName,
        model: yield* Model.ModelName,
      }),
    )

    return Stream.fromQueue(output)
  }, Stream.unwrap)

  const sendLock = Semaphore.makeUnsafe(1)

  return Agent.of({
    [TypeId]: TypeId,
    send: (options) =>
      spawn({
        agentId: agentCounter++,
        prompt: Prompt.make(options.prompt),
        system: options.system,
      }).pipe(
        Stream.broadcast({ capacity: "unbounded", replay: 1 }),
        sendLock.withPermit,
      ),
    steer: (message) =>
      Effect.callback((resume) => {
        const entry = { message, resume }
        pendingMessages.add(entry)
        return Effect.sync(() => pendingMessages.delete(entry))
      }),
  })
})

const retryPolicy = Schedule.exponential(100, 1.5).pipe(
  Schedule.either(Schedule.spaced(5000)),
  Schedule.jittered,
)

const defaultSystem = (options: {
  readonly toolInstructions: string
  readonly agentsMd: string | null
}) => `You are a world-class software engineer: precise, rigorous, thoughtful, and relentlessly careful. You fully understand the task, verify assumptions, and produce minimal, correct, maintainable solutions. You make no mistakes.

- **Fully read and understand your task** before proceeding.
- Use the current state of the codebase to inform your decisions. Don't look at git history unless explicity asked to.
- Only add comments when necessary.

${options.toolInstructions}

${options.agentsMd}
`

const generateSystemTools = (
  capabilities: AgentExecutor.Capabilities,
) => `**YOU ONLY HAVE ACCESS TO ONE TOOL** "execute", to run javascript code to do your work.

- Use \`console.log\` to print any output you need.
- Top level await is supported.${
  capabilities.supportsSearch
    ? `
- AVOID USING the "rg" function and instead use "search", unless you are targeting specific files or need regex.`
    : ""
}
- AVOID passing scripts into the "bash" function, and instead write javascript.
- Do as much work as possible in a single script, using \`Promise.all\` to run multiple functions in parallel.
- Variables **are not shared** between executions, so you must include all necessary code in each script you execute.
- Use the "delegate" function to assign complex jobs to another software engineer.

**When you have fully completed your task**, call the "taskComplete" function with the final output.
DO NOT output the final result without wrapping it with "taskComplete".
Make sure every detail of the task is done before calling "taskComplete".

Apart from standard javascript apis, **you only have** the following functions available to you:

\`\`\`ts
${capabilities.toolsDts}

/** The global Fetch API available for making HTTP requests. */
declare const fetch: typeof globalThis.fetch
\`\`\`

For example, here is how you would read a file. First you would execute
javascript code that uses the "readFile" function:

\`\`\`
const content = await readFile({
  path: "package.json",
  startLine: 1,
  endLine: 10,
})
console.log(JSON.parse(content))
\`\`\`

And then you will revieve back the console output:

\`\`\`
[22:44:53.054] INFO (#47): Calling "readFile" { path: 'package.json' }
{
  "name": "my-project",
  "version": "1.0.0"
}
\`\`\``

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
 * @category Layers
 */
export const layer: Layer.Layer<Agent, never, AgentExecutor.AgentExecutor> =
  Layer.effect(Agent, make)

/**
 * Create an Agent layer that uses a local AgentExecutor.
 *
 * @since 1.0.0
 * @category Layers
 */
export const layerLocal = <Toolkit extends Toolkit.Any = never>(options: {
  readonly directory: string
  readonly tools?: Toolkit | undefined
}): Layer.Layer<
  Agent,
  never,
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
  | Exclude<
      Toolkit extends Toolkit.Toolkit<infer T>
        ? Tool.HandlersFor<T> | Tool.HandlerServices<T[keyof T]>
        : never,
      CurrentDirectory | SubagentExecutor | TaskCompleter
    >
> => layer.pipe(Layer.provide(AgentExecutor.layerLocal(options)))

/**
 * @since 1.0.0
 * @category Subagent model
 */
export class SubagentModel extends ServiceMap.Service<
  SubagentModel,
  Layer.Layer<
    LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName
  >
>()("clanka/Agent/SubagentModel") {}

/**
 * @since 1.0.0
 * @category Subagent model
 */
export const layerSubagentModel = <E, R>(
  layer: Layer.Layer<
    LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName,
    E,
    R
  >,
): Layer.Layer<SubagentModel, E, R> =>
  Layer.effect(
    SubagentModel,
    Effect.gen(function* () {
      const services = yield* Effect.services<R>()
      return Layer.orDie(layer).pipe(
        Layer.provide(Layer.succeedServices(services)),
      )
    }),
  )

/**
 * @since 1.0.0
 * @category System prompts
 */
export class AgentModelConfig extends ServiceMap.Reference<{
  readonly systemPromptTransform?:
    | (<A, E, R>(
        system: string,
        effect: Effect.Effect<A, E, R>,
      ) => Effect.Effect<A, E, R>)
    | undefined
}>("clanka/Agent/SystemPromptTransform", {
  defaultValue: () => ({}),
}) {
  static readonly layer = (options: typeof AgentModelConfig.Service) =>
    Layer.succeed(AgentModelConfig, options)
}

/**
 * @since 1.0.0
 * @category Output
 */
export class AgentStart extends Schema.TaggedClass<AgentStart>()("AgentStart", {
  id: Schema.Number,
  prompt: Prompt.Prompt,
  provider: Schema.String,
  model: Schema.String,
}) {
  get modelAndProvider() {
    return `${this.provider}/${this.model}`
  }
}

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
export class Usage extends Schema.TaggedClass<Usage>()("Usage", {
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
}) {}

/**
 * @since 1.0.0
 * @category Output
 */
export class ErrorRetry extends Schema.TaggedClass<ErrorRetry>()("ErrorRetry", {
  error: AiError.AiError,
}) {}

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
  | Usage
  | ErrorRetry

export const ContentPart = Schema.Union([
  ReasoningStart,
  ReasoningDelta,
  ReasoningEnd,
  ScriptStart,
  ScriptDelta,
  ScriptEnd,
  ScriptOutput,
  Usage,
  ErrorRetry,
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
  | AgentStart
  | ContentPart
  | SubagentStart
  | SubagentComplete
  | SubagentPart

/**
 * @since 1.0.0
 * @category Output
 */
export const Output = Schema.Union([
  ...ContentPart.members,
  AgentStart,
  SubagentStart,
  SubagentComplete,
  SubagentPart,
])

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

/**
 * @since 1.0.0
 */
import * as Model from "effect/ai/Model"
import type * as Response from "effect/ai/Response"
import * as AgentExecutor from "./AgentExecutor.ts"
import * as AgentSkills from "./AgentSkills.ts"
import { stripWrappingCodeFence } from "./ScriptExtraction.ts"
import type * as Path from "effect/Path"
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import type * as HttpClient from "effect/http/HttpClient"
import type {
  CurrentDirectory,
  DelegateResult,
  DirectoryChanger,
  ImageAttacher,
  ImageAttachment,
  SubagentExecutor,
  SubagentResult,
  SubagentStatus,
  Subagents,
  TaskCompleter,
} from "./AgentTools.ts"
import * as Image from "./Image.ts"
import type * as FileSystem from "effect/FileSystem"
import * as Prompt from "effect/ai/Prompt"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as AiError from "effect/ai/AiError"
import * as Context from "effect/Context"
import * as Option from "effect/Option"
import { identity, pipe } from "effect/Function"
import * as MutableRef from "effect/MutableRef"
import * as Queue from "effect/Queue"
import * as Array from "effect/Array"
import * as Schema from "effect/Schema"
import * as Layer from "effect/Layer"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Semaphore from "effect/Semaphore"
import * as Schedule from "effect/Schedule"
import * as Duration from "effect/Duration"
import * as Cause from "effect/Cause"
import * as Latch from "effect/Latch"
import * as Clock from "effect/Clock"
import * as Exit from "effect/Exit"
import * as Deferred from "effect/Deferred"
import * as Fiber from "effect/Fiber"
import * as Scope from "effect/Scope"
import * as Compaction from "./Compaction.ts"
import {
  ScriptEnd,
  ScriptOutput,
  SubagentComplete,
  SubagentPart,
  SubagentStart,
  AgentFinished,
  type Output,
  ReasoningStart,
  ReasoningDelta,
  ReasoningEnd,
  Usage,
  ErrorRetry,
  ScriptStart,
  ScriptDelta,
  AgentStart,
  ExecuteOutputCapped,
  CompactionStarted,
  CompactionEnded,
} from "./AgentOutput.ts"

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

  readonly history: MutableRef.MutableRef<Prompt.Prompt>

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
export const Agent = Context.Service<Agent>("clanka/Agent")

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

  const singleTool = yield* SingleTools.pipe(Effect.provide(SingleToolHandlers))
  const capabilities = yield* executor.capabilities

  // Steering messages for the root agent. Sub-agents get their own mailbox.
  const rootMailbox = makeMailbox()

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

  const history = MutableRef.make(Prompt.empty)

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
    readonly history: MutableRef.MutableRef<Prompt.Prompt>
    readonly mailbox: Mailbox
    /**
     * Whether this agent's output is streamed for display. Background agents
     * and everything under them are not, so they never hold the output lock.
     */
    readonly display: boolean
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
    const conversationMode = yield* ConversationMode
    const turnTimeout = yield* TurnTimeout
    let finalSummary = Option.none<string>()
    // `inputTokens.total` from the most recent finish part; undefined until
    // the first response and after every compaction.
    let lastContextTokens: number | undefined = undefined
    // Images stay in the Prompt; this only decides whether they are sent.
    // Starts false for models known not to take images, and flips to false
    // after a provider rejects image input once.
    let sendImages = modelConfig.supportsImages !== false
    // Images attached by `readFile` during the current script, spliced onto
    // the Prompt as a user message once the tool result has been recorded.
    const pendingImages: Array<ImageAttachment> = []

    const output = yield* Queue.make<Output, AgentFinished | AiError.AiError>()
    let inputTokens = 0
    let outputTokens = 0
    let cacheRead = 0
    let cacheWrite = 0
    const prompt = opts.history
    const mailbox = opts.mailbox

    MutableRef.update(prompt, Prompt.concat(opts.prompt))

    const generateSystem =
      typeof opts.system === "function" ? opts.system : defaultSystem

    const toolInstructions = generateSystemTools(capabilities, conversationMode)
    let system = generateSystem({
      toolInstructions,
      agentsMd: Option.getOrElse(agentsMd, () => ""),
    })
    if (typeof opts.system === "string") {
      system += `\n${opts.system}\n`
    }

    function maybeSend(options: {
      readonly agentId: number
      readonly part: Output
      readonly acquire?: boolean
      readonly release?: boolean
    }) {
      if (!opts.display) {
        Queue.offerUnsafe(output, options.part)
        return
      }
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

    // Sub-agents. Every agent tracks only the children it spawned. They are
    // forked into a scope owned by this run, so none of them outlive it.
    const runScope = yield* Scope.make()
    const runContext = yield* Effect.context<
      LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName
    >()
    const children = new Map<string, Child>()
    // Finished turns waiting to be pushed to the model.
    const completions: Array<{ readonly child: Child; readonly turn: Turn }> =
      []
    let wakeUp: (() => void) | undefined
    const notify = () => {
      const resume = wakeUp
      wakeUp = undefined
      resume?.()
    }
    mailbox.notify = notify

    const runningChildren = () =>
      Array.Array.from(children.values()).filter(
        (child) => child.turn.status === "running",
      )
    const hasUndelivered = () => completions.some(({ turn }) => !turn.delivered)

    const finishTurn = (
      child: Child,
      turn: Turn,
      exit: Exit.Exit<string, unknown>,
    ) =>
      Effect.sync(() => {
        if (Exit.isSuccess(exit)) {
          turn.status = "completed"
          turn.output = exit.value
        } else if (Cause.hasInterruptsOnly(exit.cause)) {
          turn.status = "cancelled"
        } else {
          turn.status = "failed"
          turn.output = causeMessage(exit.cause)
        }
        Queue.offerUnsafe(
          output,
          new SubagentComplete({
            id: child.id,
            summary: turn.output ?? "",
            status: turn.status,
          }),
        )
        if (!turn.delivered) {
          completions.push({ child, turn })
        }
        Deferred.doneUnsafe(turn.done, Effect.void)
        notify()
      })

    // Starts a turn of a child in its own fiber, with this run's services
    // and the sub-agent model.
    const startTurn = Effect.fnUntraced(function* (options: {
      readonly child: Child
      readonly prompt: string
      /** Shown in the start event: the task, or the follow-up message. */
      readonly label: string
      readonly background: boolean
    }) {
      const { child } = options
      const turn: Turn = {
        status: "running",
        output: undefined,
        // Foreground results go straight back to the script.
        delivered: !options.background,
        done: Deferred.makeUnsafe(),
        fiber: undefined,
      }
      child.turn = turn
      const display = opts.display && !options.background
      const stream = spawn({
        agentId: child.id,
        prompt: Prompt.make(options.prompt),
        system: opts.system,
        history: child.history,
        mailbox: child.mailbox,
        display,
      })
      turn.fiber = yield* Effect.gen(function* () {
        maybeSend({
          agentId: opts.agentId,
          part: new SubagentStart({
            id: child.id,
            prompt: options.label,
            model: yield* Model.ModelName,
            provider: yield* Model.ProviderName,
            background: options.background,
          }),
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
                  Queue.offerUnsafe(output, part)
                  break
                case "SubagentPart":
                  if (display) Queue.offerUnsafe(output, part)
                  break
                default:
                  if (display) {
                    Queue.offerUnsafe(
                      output,
                      new SubagentPart({ id: child.id, part }),
                    )
                  }
                  break
              }
            }
            return Effect.void
          }),
          Effect.as(""),
          Effect.catchTag("AgentFinished", (finished) =>
            Effect.succeed(finished.summary),
          ),
        )
      }).pipe(
        Effect.onExit((exit) => finishTurn(child, turn, exit)),
        Effect.provide(subagentModel),
        Effect.provideService(SubagentModel, subagentModel),
        Effect.provideContext(runContext),
        Effect.forkIn(runScope, { startImmediately: true }),
      )
      return turn
    })

    const childResult = (child: Child): SubagentResult =>
      makeResult(String(child.id), child.turn.status, child.turn.output)

    const lookupChild = (id: string) =>
      Effect.suspend(() => {
        const child = children.get(id)
        return child
          ? Effect.succeed(child)
          : Effect.fail(
              `Unknown agent id ${JSON.stringify(id)}. You can only address agents you started; call listAgents() to see them.`,
            )
      })

    const subagents: Subagents = {
      delegate: Effect.fnUntraced(function* ({ prompt, background }) {
        const child = makeChild(agentCounter++, prompt)
        children.set(String(child.id), child)
        const turn = yield* startTurn({
          child,
          label: prompt,
          prompt: `You have been asked using the "delegate" function to complete the following task. Try to avoid using the "delegate" function yourself unless strictly necessary:

${prompt}`,
          background,
        })
        if (background) {
          return makeResult(
            String(child.id),
            "running",
            undefined,
          ) as DelegateResult
        }
        // Foreground: a failure crashes the script, as before. Interrupting
        // the script stops the agent.
        yield* Deferred.await(turn.done).pipe(
          Effect.onInterrupt(() => Fiber.interrupt(turn.fiber!)),
        )
        if (turn.status !== "completed") {
          return yield* Effect.die(
            new Error(
              `Sub-agent ${child.id} ${turn.status}${turn.output ? `: ${turn.output}` : ""}`,
            ),
          )
        }
        return makeResult(
          String(child.id),
          "completed",
          turn.output,
        ) as DelegateResult
      }),
      waitAgents: Effect.fnUntraced(function* (ids) {
        const targets =
          ids === undefined
            ? Array.Array.from(children.values())
            : yield* Effect.forEach(ids, lookupChild)
        // A turn started by messageAgent while waiting is waited for too.
        while (true) {
          const running = targets.find(
            (child) => child.turn.status === "running",
          )
          if (!running) break
          yield* Deferred.await(running.turn.done)
        }
        return targets.map((child) => {
          child.turn.delivered = true
          return childResult(child)
        })
      }),
      messageAgent: Effect.fnUntraced(function* ({ id, message }) {
        const child = yield* lookupChild(id)
        if (child.turn.status === "running") {
          child.mailbox.messages.add({ message, resume: () => {} })
          child.mailbox.notify()
          return childResult(child)
        }
        yield* startTurn({
          child,
          prompt: message,
          label: message,
          background: true,
        })
        return childResult(child)
      }),
      stopAgent: Effect.fnUntraced(function* (id) {
        const child = yield* lookupChild(id)
        const turn = child.turn
        turn.delivered = true
        if (turn.status === "running") {
          yield* Fiber.interrupt(turn.fiber!)
        }
        return childResult(child)
      }),
      listAgents: Effect.sync(() =>
        Array.Array.from(children.values(), (child) => ({
          id: String(child.id),
          status: child.turn.status,
          prompt: child.prompt,
        })),
      ),
    }

    const onTaskComplete = (summary: string) =>
      Effect.suspend(() => {
        const running = runningChildren()
        if (running.length > 0) {
          const ids = running.map((child) => JSON.stringify(String(child.id)))
          return Effect.fail(
            `taskComplete was rejected: sub-agents ${ids.join(", ")} are still running. Call waitAgents() to wait for them, or stopAgent(id) to stop them, before calling taskComplete.`,
          )
        }
        finalSummary = Option.some(summary)
        return Effect.void
      })

    // Blocks an idle conversation turn until a child finishes or a message
    // arrives.
    const waitForActivity = Effect.callback<void>((resume) => {
      if (
        mailbox.messages.size > 0 ||
        hasUndelivered() ||
        runningChildren().length === 0
      ) {
        resume(Effect.void)
        return
      }
      wakeUp = () => resume(Effect.void)
      return Effect.sync(() => {
        wakeUp = undefined
      })
    })

    // Turn timeout
    const clock = yield* Clock.Clock
    const turnTimeoutMs = Duration.toMillis(turnTimeout)
    let turnExpires = 0
    const turnTimeoutReset = () => {
      turnExpires = clock.currentTimeMillisUnsafe() + turnTimeoutMs
    }
    const toolLatch = Latch.makeUnsafe(true)
    const toolLatchAcquire = toolLatch.close
    const toolLatchRelease = Effect.sync(() => {
      turnTimeoutReset()
      toolLatch.openUnsafe()
    })
    const turnTimeoutEffect = Effect.gen(function* () {
      toolLatch.openUnsafe()
      turnTimeoutReset()
      while (true) {
        yield* Effect.sleep(turnExpires - clock.currentTimeMillisUnsafe())
        yield* toolLatch.await
        const remaining = turnExpires - clock.currentTimeMillisUnsafe()
        if (remaining > 0) continue
        return yield* new Cause.TimeoutError()
      }
    })

    // Compaction. `compactWithEvents` applies a successful rewrite and closes
    // the progress event on every exit: success, failure, timeout, interrupt.
    let compactionStarted = false
    const onCompactionStart = (reason: Compaction.CompactionReason) =>
      Effect.sync(() => {
        compactionStarted = true
        maybeSend({ agentId, part: new CompactionStarted({ reason }) })
      })
    const compactWithEvents = <E, R>(
      reason: Compaction.CompactionReason,
      compaction: Effect.Effect<
        Option.Option<Compaction.CompactionResult>,
        E,
        R
      >,
    ) =>
      Effect.suspend(() => {
        compactionStarted = false
        return compaction
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (!compactionStarted) return
            const result = Exit.isSuccess(exit) ? exit.value : Option.none()
            let tokensBefore: number
            let tokensAfter: number
            if (Option.isSome(result)) {
              MutableRef.set(prompt, result.value.prompt)
              lastContextTokens = undefined
              tokensBefore = result.value.tokensBefore
              tokensAfter = result.value.tokensAfter
            } else {
              tokensBefore = tokensAfter = Compaction.estimateTokens(
                prompt.current,
              )
            }
            maybeSend({
              agentId,
              part: new CompactionEnded({ reason, tokensBefore, tokensAfter }),
            })
          }),
        ),
      )

    // Script execution
    const executeScript = Effect.fnUntraced(function* (script: string) {
      yield* toolLatchAcquire
      maybeSend({ agentId, part: new ScriptEnd(), release: true })
      const normalizedScript = stripWrappingCodeFence(script)
      const output = yield* pipe(
        executor.execute({
          script: normalizedScript,
          subagents,
          onTaskComplete,
          onImage: (image) =>
            Effect.sync(() => {
              pendingImages.push(image)
            }),
        }),
        Stream.mkString,
      )
      // Always-on cap on what enters the Prompt. The ScriptOutput event keeps
      // the full output for display; the formatter applies its own truncation.
      const capped = Compaction.capOutput(output)
      if (capped.capped) {
        maybeSend({
          agentId,
          part: new ExecuteOutputCapped({
            charsBefore: capped.charsBefore,
            charsAfter: capped.charsAfter,
          }),
        })
      }
      maybeSend({ agentId, part: new ScriptOutput({ output }) })
      return capped.output
    }, Effect.ensuring(toolLatchRelease))

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

        if (mailbox.messages.size > 0) {
          MutableRef.update(
            prompt,
            Prompt.concat(
              Array.Array.from(mailbox.messages, ({ message, resume }) => {
                resume(Effect.void)
                return {
                  role: "user",
                  content: message,
                }
              }),
            ),
          )
          mailbox.messages.clear()
        }

        // Completion pushes from background sub-agents. These have their own
        // queue: the steering path above cuts the model stream short.
        if (completions.length > 0) {
          const pushes = completions.splice(0).filter(({ turn }) => {
            if (turn.delivered) return false
            turn.delivered = true
            return true
          })
          if (pushes.length > 0) {
            MutableRef.update(
              prompt,
              Prompt.concat(
                pushes.map(({ child, turn }) => ({
                  role: "user" as const,
                  content: `<subagent id="${child.id}" status="${turn.status}">
${Compaction.capOutput(turn.output ?? "").output}
</subagent>`,
                })),
              ),
            )
          }
        }

        // Threshold compaction before the next model call
        yield* compactWithEvents(
          "threshold",
          Compaction.compactIfNeeded({
            prompt: prompt.current,
            contextTokens: lastContextTokens,
            onStart: onCompactionStart,
          }).pipe(Effect.timeout(turnTimeout)),
        ).pipe(
          Effect.catchTag("TimeoutError", (error) =>
            Effect.logWarning(
              "Compaction timed out, continuing with the uncompacted prompt",
              error,
            ),
          ),
        )

        // oxlint-disable-next-line typescript/no-explicit-any
        let response = Array.empty<Response.StreamPart<any>>()
        const discardAttempt = () => {
          response = []
          pendingImages.length = 0
        }
        let reasoningStarted = false
        let hadReasoningDelta = false
        let hadToolCall = false
        const runModel = pipe(
          Stream.suspend(() =>
            ai.streamText({
              prompt: sendImages
                ? prompt.current
                : Image.stripImages(prompt.current),
              toolkit: singleTool,
            }),
          ),
          Stream.takeUntil((part) => {
            if (
              (part.type === "text-end" || part.type === "reasoning-end") &&
              mailbox.messages.size > 0
            ) {
              return true
            }
            return false
          }),
          Stream.runForEachArray((parts) => {
            response.push(...parts)
            turnTimeoutReset()

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
                  if (usage.inputTokens.cacheRead !== undefined) {
                    cacheRead += usage.inputTokens.cacheRead
                  }
                  if (usage.inputTokens.cacheWrite !== undefined) {
                    cacheWrite += usage.inputTokens.cacheWrite
                  }
                  if (usage.inputTokens.total !== undefined) {
                    lastContextTokens = usage.inputTokens.total
                    inputTokens += usage.inputTokens.total
                    maybeSend({
                      agentId,
                      part: new Usage({
                        contextTokens: usage.inputTokens.total,
                        inputTokens,
                        outputTokens,
                        cacheRead,
                        cacheWrite,
                      }),
                    })
                  }
                  break
                case "tool-call":
                  hadToolCall = true
                  break
              }
            }
            return Effect.void
          }),
          modelConfig.systemPromptTransform
            ? (effect) => modelConfig.systemPromptTransform!(system, effect)
            : identity,
        )
        const attempt = pipe(
          runModel,
          Effect.raceFirst(turnTimeoutEffect),
          Effect.retry({
            while(err) {
              if (err._tag === "TimeoutError") {
                maybeSend({
                  agentId,
                  part: new ErrorRetry({
                    error: AiError.make({
                      module: "clanka/Agent",
                      method: "send",
                      reason: new AiError.UnknownError({
                        description: "TurnTimeout was reached",
                      }),
                    }),
                  }),
                })
                discardAttempt()
                return true
              }
              // Never retry a context-length error as is: the overflow
              // handler below compacts first.
              if (Compaction.isContextLengthError(err)) return false
              if (err.isRetryable) {
                maybeSend({ agentId, part: new ErrorRetry({ error: err }) })
                switch (err.reason._tag) {
                  case "ToolNotFoundError":
                  case "InvalidOutputError": {
                    const toAppend = Prompt.fromResponseParts(response).pipe(
                      Prompt.concat(
                        `There was an error, please try again using the "execute" tool:\n\n${Cause.pretty(Cause.fail(err))}`,
                      ),
                    )
                    MutableRef.update(prompt, Prompt.concat(toAppend))
                  }
                }
              }
              discardAttempt()
              return err.isRetryable
            },
            schedule: retryPolicy,
          }),
          Effect.catchTag("TimeoutError", Effect.die),
        )
        // Unsupported images: drop them from the request and retry once.
        // The images stay in the Prompt with an omitted note in their place.
        const attemptWithImageFallback = attempt.pipe(
          Effect.catchIf(
            (err): err is AiError.AiError =>
              sendImages &&
              Image.hasImages(prompt.current) &&
              Image.isUnsupportedImageError(err),
            (err) => {
              sendImages = false
              discardAttempt()
              maybeSend({ agentId, part: new ErrorRetry({ error: err }) })
              return attempt
            },
          ),
        )
        // Overflow: compact once, retry the attempt once, then fail.
        yield* attemptWithImageFallback.pipe(
          Effect.catchIf(
            (err): err is AiError.AiError =>
              Compaction.isContextLengthError(err),
            (err) =>
              Effect.gen(function* () {
                discardAttempt()
                const compacted = yield* compactWithEvents(
                  "overflow",
                  Compaction.compact({
                    prompt: prompt.current,
                    reason: "overflow",
                    onStart: onCompactionStart,
                  }).pipe(
                    Effect.timeout(turnTimeout),
                    Effect.retry({
                      while: (error) => error._tag === "TimeoutError",
                      times: 1,
                    }),
                    Effect.catchTag("TimeoutError", Effect.die),
                  ),
                )
                return Option.isSome(compacted)
                  ? yield* attemptWithImageFallback
                  : yield* err
              }),
          ),
        )
        MutableRef.update(
          prompt,
          Prompt.concat(Prompt.fromResponseParts(response)),
        )
        if (pendingImages.length > 0) {
          // After the tool result, so call / result pairing stays intact.
          MutableRef.update(
            prompt,
            Prompt.concat(
              Prompt.fromMessages([Image.userMessage(pendingImages)]),
            ),
          )
          pendingImages.length = 0
        }
        if (conversationMode && !hadToolCall && mailbox.messages.size === 0) {
          // The run is not over while children are running or their results
          // have not been seen yet.
          if (runningChildren().length > 0 || hasUndelivered()) {
            yield* waitForActivity
            continue
          }
          finalSummary = Option.some(responseToSummary(response))
        }
      }
    }).pipe(
      Effect.provideService(ScriptExecutor, (script) => {
        maybeSend({ agentId, part: new ScriptStart() })
        maybeSend({ agentId, part: new ScriptDelta({ delta: script }) })
        return executeScript(script)
      }),
      Effect.ensuring(Scope.close(runScope, Exit.void)),
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
    history,
    send: (options) =>
      spawn({
        agentId: agentCounter++,
        prompt: Prompt.make(options.prompt),
        system: options.system,
        history,
        mailbox: rootMailbox,
        display: true,
      }).pipe(
        Stream.broadcast({ capacity: "unbounded", replay: 1 }),
        sendLock.withPermit,
      ),
    steer: (message) =>
      Effect.callback((resume) => {
        const entry = { message, resume }
        rootMailbox.messages.add(entry)
        rootMailbox.notify()
        return Effect.sync(() => rootMailbox.messages.delete(entry))
      }),
  })
})

interface Mailbox {
  readonly messages: Set<{
    readonly message: string
    readonly resume: (effect: Effect.Effect<void>) => void
  }>
  /** Wakes the agent's run if it is waiting for activity. */
  notify: () => void
}

const makeMailbox = (): Mailbox => ({
  messages: new Set(),
  notify: () => {},
})

interface Child {
  readonly id: number
  readonly prompt: string
  /** Kept for the whole run so `messageAgent` can resume the agent. */
  readonly history: MutableRef.MutableRef<Prompt.Prompt>
  readonly mailbox: Mailbox
  /** The latest turn. Replaced when `messageAgent` resumes the agent. */
  turn: Turn
}

interface Turn {
  status: SubagentStatus
  output: string | undefined
  /** Whether the model has seen this result. Undelivered results are pushed. */
  delivered: boolean
  readonly done: Deferred.Deferred<void>
  fiber: Fiber.Fiber<string, AiError.AiError> | undefined
}

const makeChild = (id: number, prompt: string): Child => ({
  id,
  prompt,
  history: MutableRef.make(Prompt.empty),
  mailbox: makeMailbox(),
  // Replaced by the first `startTurn` before anything reads it.
  turn: {
    status: "running",
    output: undefined,
    delivered: true,
    done: Deferred.makeUnsafe(),
    fiber: undefined,
  },
})

const makeResult = (
  id: string,
  status: SubagentStatus,
  output: string | undefined,
): SubagentResult =>
  output === undefined ? { id, status } : { id, status, output }

const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  return AiError.isAiError(error)
    ? error.message
    : error instanceof Error
      ? error.message
      : String(error)
}

const retryPolicy = Schedule.min([
  Schedule.exponential(100, 1.5),
  Schedule.spaced(5000),
]).pipe(Schedule.jittered)

const defaultSystem = (options: {
  readonly toolInstructions: string
  readonly agentsMd: string | null
}) => `You are a world-class software engineer: precise and efficient.

${options.toolInstructions}

${options.agentsMd}
`

const generateSystemTools = (
  capabilities: AgentExecutor.Capabilities,
  conversationMode: boolean,
) => `YOU ONLY HAVE ONE TOOL AVAILABLE: "execute", to run javascript code to do your work.

- Use \`console.log\` to print any output you need.
- Use top level await.${
  capabilities.supportsSearch
    ? `
- Prefer using the "search" function over "rg", unless you are targeting specific files or patterns.`
    : ""
}
- You can add / update / remove multiple files in one go with "applyPatch".
- Avoid passing scripts into the "bash" function, and instead write javascript.
- Variables are not shared between executions.
- Do not use \`require\`, \`import\`, \`process\`, or any other Node.js apis.
- "delegate" runs a sub-agent and waits for it. Pass \`background: true\` to keep working while it runs: its result is sent to you later as a \`<subagent id="..." status="...">\` message. Use the returned id with "waitAgents", "messageAgent" and "stopAgent"; "listAgents" shows the agents you started.${
  conversationMode
    ? ""
    : `

When you have fully completed your task, call the "taskComplete" function with the final output.
Make sure every detail of the task is done before calling "taskComplete".
Wait for or stop any running sub-agents first: "taskComplete" fails while they are running.`
}

Here is how you would read a file and list a directory:

\`\`\`
const [files, content] = await Promise.all([
  ls("."),
  readFile({
    path: "package.json",
    startLine: 1,
    endLine: 10,
  })
])
console.log("files:", files)
console.log("package.json:", JSON.parse(content))
\`\`\`

And then you will revieve back the console output:

\`\`\`
[22:44:53.050] INFO (#47): Calling "ls" { directory: '.' }
[22:44:53.054] INFO (#47): Calling "readFile" { path: 'package.json' }
files: [ 'package.json' ]
package.json: {
  "name": "my-project",
  "version": "1.0.0"
}
\`\`\`

These are the functions available to you:

\`\`\`ts
${capabilities.toolsDts}

/** The global Fetch API available for making HTTP requests. */
declare const fetch: typeof globalThis.fetch
\`\`\`${Option.match(AgentSkills.renderCatalog(capabilities.skills), {
  onNone: () => "",
  onSome: (catalog) => `

${catalog}`,
})}`

class ScriptExecutor extends Context.Service<
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
      | CurrentDirectory
      | DirectoryChanger
      | SubagentExecutor
      | TaskCompleter
      | ImageAttacher
    >
> => layer.pipe(Layer.provide(AgentExecutor.layerLocal(options)))

/**
 * @since 1.0.0
 * @category Subagent model
 */
export class SubagentModel extends Context.Service<
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
      const services = yield* Effect.context<R>()
      return Layer.orDie(layer).pipe(
        Layer.provide(Layer.succeedContext(services)),
      )
    }),
  )

/**
 * @since 1.0.0
 * @category Conversation mode
 */
export class ConversationMode extends Context.Reference<boolean>(
  "clanka/Agent/ConversationMode",
  {
    defaultValue: () => false,
  },
) {
  static readonly layer = (enabled: boolean) =>
    Layer.succeed(ConversationMode, enabled)
}

/**
 * Specify an inactivity timeout before retrying a turn.
 *
 * @since 1.0.0
 * @category Turn timeout
 */
export class TurnTimeout extends Context.Reference<Duration.Duration>(
  "clanka/Agent/TurnTimeout",
  {
    defaultValue: () => Duration.minutes(5),
  },
) {
  static readonly layer = (timeout: Duration.Input) =>
    Layer.succeed(TurnTimeout, Duration.fromInputUnsafe(timeout))
}

/**
 * @since 1.0.0
 * @category System prompts
 */
export class AgentModelConfig extends Context.Reference<{
  readonly systemPromptTransform?:
    | (<A, E, R>(
        system: string,
        effect: Effect.Effect<A, E, R>,
      ) => Effect.Effect<A, E, R>)
    | undefined
  /**
   * `false` for models known not to take image input: image parts are
   * stripped before every request. Leave unset when unknown; the Agent then
   * sends images and retries once without them if the provider rejects
   * them.
   */
  readonly supportsImages?: boolean | undefined
}>("clanka/Agent/SystemPromptTransform", {
  defaultValue: () => ({}),
}) {
  static readonly layer = (options: typeof AgentModelConfig.Service) =>
    Layer.succeed(AgentModelConfig, options)
}

const responseToSummary = (
  response: ReadonlyArray<Response.AnyPart>,
): string => {
  const prompt = Prompt.fromResponseParts(response)
  let parts = Array.empty<string>()
  for (const message of prompt.content) {
    if (message.role !== "assistant") continue
    for (const part of message.content) {
      if (part.type === "text") {
        parts.push(part.text)
      }
    }
  }
  return parts.join("\n\n")
}

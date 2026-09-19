import { assert, describe, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as FileSystem from "effect/FileSystem"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as Effect from "effect/Effect"
import * as Duration from "effect/Duration"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as MutableRef from "effect/MutableRef"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as AiError from "effect/unstable/ai/AiError"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Model from "effect/unstable/ai/Model"
import * as Prompt from "effect/unstable/ai/Prompt"
import type * as Response from "effect/unstable/ai/Response"
import * as ResponseIdTracker from "effect/unstable/ai/ResponseIdTracker"
import * as Agent from "./Agent.ts"
import * as AgentExecutor from "./AgentExecutor.ts"
import type * as AgentOutput from "./AgentOutput.ts"
import * as Compaction from "./Compaction.ts"

const capabilities = new AgentExecutor.Capabilities({
  toolsDts: "",
  agentsMd: Option.none(),
  supportsSearch: false,
  skills: [],
})

const makeExecutor = (
  execute: AgentExecutor.AgentExecutor["Service"]["execute"] = () =>
    Stream.empty,
) =>
  AgentExecutor.AgentExecutor.of({
    capabilities: Effect.succeed(capabilities),
    execute,
    executeUnsafe: () => Effect.die("executeUnsafe not implemented"),
  })

const runAgent = (options: {
  readonly conversationMode?: boolean | undefined
  readonly executor?: AgentExecutor.AgentExecutor["Service"] | undefined
  readonly streamText: Parameters<typeof LanguageModel.make>[0]["streamText"]
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const languageModel = yield* LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: options.streamText,
      })
      const modelLayer = Layer.mergeAll(
        Layer.succeed(LanguageModel.LanguageModel, languageModel),
        Layer.succeed(Model.ProviderName, "test-provider"),
        Layer.succeed(Model.ModelName, "test-model"),
      )
      const agent = yield* Agent.make.pipe(
        Effect.provideService(
          AgentExecutor.AgentExecutor,
          options.executor ?? makeExecutor(),
        ),
      )

      return yield* agent.send({ prompt: "hello" }).pipe(
        Effect.flatMap((stream) =>
          stream.pipe(
            Stream.runDrain,
            Effect.as(""),
            Effect.catchTag("AgentFinished", (finished) =>
              Effect.succeed(finished.summary),
            ),
          ),
        ),
        Effect.provide(
          Layer.mergeAll(
            modelLayer,
            Agent.ConversationMode.layer(options.conversationMode ?? false),
            Agent.layerSubagentModel(modelLayer),
          ),
        ),
      )
    }),
  )

describe("Agent", () => {
  it.effect("ConversationMode defaults to false", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* Agent.ConversationMode, false)
    }),
  )

  it.effect(
    "finishes with the assistant response when conversation mode is enabled",
    () =>
      runAgent({
        conversationMode: true,
        streamText: () =>
          Stream.fromIterable([
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "Hello from the assistant" },
            { type: "text-end", id: "1" },
          ]),
      }).pipe(
        Effect.map((summary) => {
          assert.strictEqual(summary, "Hello from the assistant")
        }),
      ),
  )

  it.effect(
    "still finishes when taskComplete is called in conversation mode",
    () =>
      runAgent({
        conversationMode: true,
        executor: makeExecutor(({ onTaskComplete }) =>
          Stream.fromEffect(
            onTaskComplete("done from taskComplete").pipe(Effect.as("")),
          ),
        ),
        streamText: () =>
          Stream.fromIterable([
            {
              type: "tool-call",
              id: "call-1",
              name: "execute",
              params: {
                script: 'await taskComplete("done from taskComplete")',
              },
            },
          ]),
      }).pipe(
        Effect.map((summary) => {
          assert.strictEqual(summary, "done from taskComplete")
        }),
      ),
  )
})

// =============================================================================
// Compaction acceptance tests
//
// These drive the real Agent loop with a scripted LanguageModel. Every
// model call is recorded so tests can assert on exactly what the model
// was sent. The summarizer call is recognised by having no tools.
// =============================================================================

interface RecordedCall {
  readonly method: "generateText" | "streamText"
  readonly prompt: Prompt.Prompt
  readonly isSummarizer: boolean
}

type ScriptedResponse = (
  call: RecordedCall,
  index: number,
) => Stream.Stream<Response.StreamPartEncoded, AiError.AiError>

const runAgentCollect = (options: {
  readonly conversationMode?: boolean | undefined
  readonly executor?: AgentExecutor.AgentExecutor["Service"] | undefined
  readonly history?: Prompt.Prompt | undefined
  readonly compaction?: Partial<Compaction.CompactionConfigService> | undefined
  readonly prompt?: string | undefined
  readonly turnTimeout?: Duration.Duration | undefined
  readonly respond: ScriptedResponse
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: Array<RecordedCall> = []
      const outputs: Array<AgentOutput.Output> = []

      const languageModel = yield* LanguageModel.make({
        generateText: (providerOptions) => {
          const call: RecordedCall = {
            method: "generateText",
            prompt: providerOptions.prompt,
            isSummarizer: providerOptions.tools.length === 0,
          }
          const index = calls.push(call) - 1
          return options.respond(call, index).pipe(
            Stream.runCollect,
            Effect.map((parts): Array<Response.PartEncoded> => {
              const text = parts
                .flatMap((part) =>
                  part.type === "text-delta" ? [part.delta] : [],
                )
                .join("")
              return [
                { type: "text", text },
                ...parts.filter((part) => part.type === "finish"),
              ]
            }),
          )
        },
        streamText: (providerOptions) => {
          const call: RecordedCall = {
            method: "streamText",
            prompt: providerOptions.prompt,
            isSummarizer: providerOptions.tools.length === 0,
          }
          const index = calls.push(call) - 1
          return options.respond(call, index)
        },
      })
      const modelLayer = Layer.mergeAll(
        Layer.succeed(LanguageModel.LanguageModel, languageModel),
        Layer.succeed(Model.ProviderName, "test-provider"),
        Layer.succeed(Model.ModelName, "test-model"),
      )
      const agent = yield* Agent.make.pipe(
        Effect.provideService(
          AgentExecutor.AgentExecutor,
          options.executor ?? makeExecutor(),
        ),
      )
      if (options.history) {
        MutableRef.set(agent.history, options.history)
      }

      const exit = yield* agent
        .send({ prompt: options.prompt ?? "hello" })
        .pipe(
          Effect.flatMap((stream) =>
            stream.pipe(
              Stream.runForEach((output) =>
                Effect.sync(() => {
                  outputs.push(output)
                }),
              ),
              Effect.as(""),
              Effect.catchTag("AgentFinished", (finished) =>
                Effect.succeed(finished.summary),
              ),
            ),
          ),
          Effect.provide(
            Layer.mergeAll(
              modelLayer,
              Agent.ConversationMode.layer(options.conversationMode ?? true),
              Agent.layerSubagentModel(modelLayer),
              Compaction.CompactionConfig.layer(options.compaction ?? {}),
              Layer.succeed(
                Agent.TurnTimeout,
                options.turnTimeout ?? Duration.minutes(5),
              ),
            ),
          ),
          Effect.exit,
        )

      return { exit, calls, outputs, history: agent.history.current }
    }),
  )

// --- fixtures ----------------------------------------------------------------

const filler = (word: string, n: number) =>
  (word + " ").repeat(Math.ceil(n / (word.length + 1))).slice(0, n)

const user = (text: string) =>
  Prompt.makeMessage("user", {
    content: [Prompt.makePart("text", { text })],
  })

const assistantCall = (id: string, script: string) =>
  Prompt.makeMessage("assistant", {
    content: [
      Prompt.makePart("tool-call", {
        id,
        name: "execute",
        params: { script },
        providerExecuted: false,
      }),
    ],
  })

const toolResult = (id: string, result: string) =>
  Prompt.makeMessage("tool", {
    content: [
      Prompt.makePart("tool-result", {
        id,
        name: "execute",
        isFailure: false,
        result,
        providerExecuted: false,
      }),
    ],
  })

/**
 * A history with two prior execute turns whose results carry unique
 * sentinels, so tests can check what survived compaction. Each result is
 * about 30k chars (~7.5k tokens), so the whole thing is ~15k tokens.
 */
const fatHistory = Prompt.fromMessages([
  user("Investigate the failing build"),
  assistantCall("call-1", "await readFile({ path: 'big1.log' })"),
  toolResult("call-1", "SENTINEL-ONE " + filler("first", 30_000)),
  assistantCall("call-2", "await readFile({ path: 'big2.log' })"),
  toolResult("call-2", "SENTINEL-TWO " + filler("second", 30_000)),
])

const toolCall = (id: string, script: string): Response.StreamPartEncoded => ({
  type: "tool-call",
  id,
  name: "execute",
  params: { script },
})

const finish = (
  contextTokens: number,
  reason: "stop" | "tool-calls" = "tool-calls",
): Response.StreamPartEncoded => ({
  type: "finish",
  reason,
  usage: {
    inputTokens: { total: contextTokens },
    outputTokens: { total: 10 },
  },
})

const text = (content: string): Array<Response.StreamPartEncoded> => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: content },
  { type: "text-end", id: "t" },
]

const contextLengthError = AiError.make({
  module: "OpenAiLanguageModel",
  method: "streamText",
  reason: new AiError.InvalidRequestError({
    description:
      "Your input exceeds the context window of this model. Please adjust your input and try again. (POST https://chatgpt.com/backend-api/codex/responses) [code: context_length_exceeded]",
  }),
})

const providerError = AiError.make({
  module: "OpenAiLanguageModel",
  method: "streamText",
  reason: new AiError.InternalProviderError({
    description: "Server error",
  }),
})

const encodePrompt = Schema.encodeSync(Prompt.Prompt)
const promptJson = (prompt: Prompt.Prompt) =>
  JSON.stringify(encodePrompt(prompt))

const toolResults = (prompt: Prompt.Prompt): Array<Prompt.ToolResultPart> =>
  prompt.content.flatMap((message) =>
    message.role === "tool"
      ? message.content.filter(
          (part): part is Prompt.ToolResultPart => part.type === "tool-result",
        )
      : [],
  )

const parts = (message: Prompt.Message): ReadonlyArray<Prompt.Part> =>
  typeof message.content === "string" ? [] : message.content

const toolCallIds = (prompt: Prompt.Prompt): Array<string> =>
  prompt.content.flatMap((message) =>
    parts(message).flatMap((part) =>
      part.type === "tool-call" || part.type === "tool-result" ? [part.id] : [],
    ),
  )

const outputsOfTag = <Tag extends AgentOutput.Output["_tag"]>(
  outputs: ReadonlyArray<AgentOutput.Output>,
  tag: Tag,
) =>
  outputs.filter(
    (output): output is Extract<AgentOutput.Output, { _tag: Tag }> =>
      output._tag === tag,
  )

const assertSummarizerCall = (call: RecordedCall) => {
  assert.isTrue(call.isSummarizer, "expected the summarizer call (no tools)")
  assert.isFalse(
    call.prompt.content.some((m) => m.role === "tool"),
    "summarizer input must not contain raw tool messages",
  )
}

const assertCompactedShape = (
  prompt: Prompt.Prompt,
  summary: string,
): ReadonlyArray<Prompt.Message> => {
  assert.strictEqual(prompt.content[0]?.role, "system", "system message first")
  const summaryMessage = prompt.content[1]
  assert.strictEqual(
    summaryMessage?.role,
    "user",
    "summary user message second",
  )
  const part = parts(summaryMessage!)[0]
  assert.strictEqual(part?.type, "text")
  assert.strictEqual(
    (part as Prompt.TextPart).text,
    Compaction.wrapSummary(summary),
  )
  assert.strictEqual(
    prompt.content.filter((m) => m.role === "system").length,
    1,
    "exactly one system message",
  )
  return prompt.content.slice(2)
}

const withLocalExecutor = <A, E, R>(
  f: (
    executor: AgentExecutor.AgentExecutor["Service"],
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    return yield* AgentExecutor.AgentExecutor.use(f).pipe(
      Effect.provide(AgentExecutor.layerLocal({ directory })),
    )
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    Effect.scoped,
  )

const invalidCompletions = [
  'taskComplete({ output: "done" })',
  "taskComplete()",
  "taskComplete(undefined)",
  "taskComplete(null)",
  "taskComplete(42)",
  "taskComplete(true)",
  'taskComplete(["done"])',
  'taskComplete({ summary: "done" })',
]

describe("taskComplete through the real VM executor", () => {
  for (const summary of ["done", "", "First line\nSecond line"]) {
    it.live(`finishes with string summary ${JSON.stringify(summary)}`, () =>
      withLocalExecutor((executor) =>
        runAgentCollect({
          conversationMode: false,
          executor,
          respond: (_call, index) =>
            index === 0
              ? Stream.fromIterable([
                  toolCall(
                    "complete",
                    `await taskComplete(${JSON.stringify(summary)})`,
                  ),
                ])
              : Stream.die("completion must not require another model call"),
        }).pipe(
          Effect.map(({ exit, calls }) => {
            assert.deepStrictEqual(exit, Exit.succeed(summary))
            assert.strictEqual(calls.length, 1)
          }),
        ),
      ),
    )
  }

  for (const invocation of invalidCompletions) {
    it.live(`rejects ${invocation} without completing`, () =>
      withLocalExecutor((executor) =>
        Effect.gen(function* () {
          const summaries: Array<string> = []
          const output = yield* executor
            .execute({
              script: `try { await ${invocation}; console.log("ACCEPTED") } catch (error) { console.log("REJECTED:", String(error)) } console.log("SCRIPT_SURVIVED")`,
              onTaskComplete: (summary) =>
                Effect.sync(() => {
                  summaries.push(summary)
                }),
              onSubagent: () => Effect.succeed(""),
              onImage: () => Effect.void,
            })
            .pipe(Stream.mkString)
          assert.deepStrictEqual(
            summaries,
            [],
            "invalid input must not reach TaskCompleter",
          )
          assert.include(output, "REJECTED:")
          assert.match(output, /string/i)
          assert.include(output, "SCRIPT_SURVIVED")
          assert.notInclude(output, "ACCEPTED")
        }),
      ),
    )

    it.live(`survives ${invocation} and completes on the next model call`, () =>
      withLocalExecutor((executor) =>
        runAgentCollect({
          conversationMode: false,
          executor,
          respond: (_call, index) => {
            switch (index) {
              case 0:
                return Stream.fromIterable([
                  toolCall("invalid", `await ${invocation}`),
                ])
              case 1:
                return Stream.fromIterable([
                  toolCall("retry", 'await taskComplete("recovered")'),
                ])
              default:
                return Stream.die("unexpected model call after completion")
            }
          },
        }).pipe(
          Effect.map(({ exit, calls }) => {
            assert.deepStrictEqual(exit, Exit.succeed("recovered"))
            assert.strictEqual(calls.length, 2)
            const [result] = toolResults(calls[1]!.prompt)
            assert.isDefined(
              result,
              "the model must receive the recoverable tool error",
            )
            assert.match(String(result!.result), /string/i)
          }),
        ),
      ),
    )
  }
})

// --- tests -------------------------------------------------------------------

describe("Agent execute output cap", () => {
  const dump = "DUMP-HEAD " + filler("log", 40_000) + " DUMP-TAIL"

  const runCapped = (
    compaction?: Partial<Compaction.CompactionConfigService>,
  ) =>
    runAgentCollect({
      compaction,
      executor: makeExecutor(() => Stream.succeed(dump)),
      respond: (_call, index) => {
        switch (index) {
          case 0:
            return Stream.fromIterable([
              toolCall("call-1", "await readFile({ path: 'x' })"),
              finish(500),
            ])
          case 1:
            return Stream.fromIterable([
              ...text("all done"),
              finish(600, "stop"),
            ])
          default:
            return Stream.die(`unexpected model call #${index}`)
        }
      },
    })

  it.effect("caps a single execute result over 32k chars in history", () =>
    Effect.gen(function* () {
      const { exit, calls, outputs, history } = yield* runCapped()
      assert.isTrue(Exit.isSuccess(exit), "turn should finish")
      assert.strictEqual(calls.length, 2)

      // What the model saw on the next call
      const [result] = toolResults(calls[1]!.prompt)
      assert.isDefined(result)
      const seen = result.result as string
      assert.isBelow(seen.length, dump.length)
      assert.isAtMost(seen.length, Compaction.executeOutputCapChars + 1_000)
      assert.isTrue(seen.startsWith("DUMP-HEAD"), "head kept")
      assert.isTrue(seen.endsWith("DUMP-TAIL"), "tail kept")
      assert.include(
        seen,
        "startLine",
        "marker tells the model to narrow the read",
      )

      // What was persisted in the live history (ACP persists this)
      const [persisted] = toolResults(history)
      assert.strictEqual(persisted?.result, seen)

      // Event for the CLI
      const capped = outputsOfTag(outputs, "ExecuteOutputCapped")
      assert.strictEqual(capped.length, 1)
      assert.strictEqual(capped[0]!.charsBefore, dump.length)
      assert.strictEqual(capped[0]!.charsAfter, seen.length)
    }),
  )

  it.effect("does not touch results under the cap", () =>
    Effect.gen(function* () {
      const small = "small output"
      const { calls, outputs } = yield* runAgentCollect({
        executor: makeExecutor(() => Stream.succeed(small)),
        respond: (_call, index) =>
          index === 0
            ? Stream.fromIterable([toolCall("call-1", "ls()"), finish(100)])
            : Stream.fromIterable(text("ok")),
      })
      const [result] = toolResults(calls[1]!.prompt)
      assert.strictEqual(result?.result, small)
      assert.strictEqual(outputsOfTag(outputs, "ExecuteOutputCapped").length, 0)
    }),
  )

  it.effect("still caps when compaction is disabled", () =>
    Effect.gen(function* () {
      const { exit, calls, outputs } = yield* runCapped({ enabled: false })
      assert.isTrue(Exit.isSuccess(exit))
      const [result] = toolResults(calls[1]!.prompt)
      assert.isAtMost(
        (result!.result as string).length,
        Compaction.executeOutputCapChars + 1_000,
      )
      assert.strictEqual(outputsOfTag(outputs, "ExecuteOutputCapped").length, 1)
      assert.strictEqual(outputsOfTag(outputs, "CompactionStarted").length, 0)
      assert.isTrue(
        calls.every((c) => !c.isSummarizer),
        "no summarizer call",
      )
    }),
  )
})

describe("Agent auto-compaction", () => {
  it.effect(
    "streams summarization without tools and streams the next turn",
    () =>
      Effect.gen(function* () {
        const result = yield* runAgentCollect({
          history: fatHistory,
          compaction: {
            contextWindow: 12_000,
            reserveTokens: 2_000,
            keepRecentTokens: 9_000,
          },
          respond: (call) =>
            Stream.fromIterable(
              text(call.isSummarizer ? "GENERATED-SUMMARY" : "continued"),
            ),
        })
        assert.deepStrictEqual(result.exit, Exit.succeed("continued"))
        assert.deepStrictEqual(
          result.calls.map((call) => call.method),
          ["streamText", "streamText"],
        )
        assertSummarizerCall(result.calls[0]!)
        assertCompactedShape(result.calls[1]!.prompt, "GENERATED-SUMMARY")
      }),
  )

  it.live(
    "times out a stalled threshold summarizer and continues with the original prompt",
    () =>
      Effect.gen(function* () {
        let interrupted = false
        const result = yield* runAgentCollect({
          history: fatHistory,
          turnTimeout: Duration.millis(100),
          compaction: {
            contextWindow: 12_000,
            reserveTokens: 2_000,
            keepRecentTokens: 9_000,
          },
          respond: (call, index) => {
            if (index === 0) {
              assertSummarizerCall(call)
              return Stream.fromEffect(Effect.never).pipe(
                Stream.ensuring(
                  Effect.sync(() => {
                    interrupted = true
                  }),
                ),
              )
            }
            assert.isFalse(call.isSummarizer)
            assert.include(promptJson(call.prompt), "SENTINEL-ONE")
            assert.isTrue(
              Option.isNone(Compaction.findPreviousSummary(call.prompt)),
            )
            return Stream.fromIterable(text("continued after timeout"))
          },
        }).pipe(Effect.timeoutOption("2 seconds"))
        assert.isTrue(
          Option.isSome(result),
          "threshold summarization must not hang the turn",
        )
        const { exit, calls, outputs } = Option.getOrThrow(result)
        assert.deepStrictEqual(exit, Exit.succeed("continued after timeout"))
        assert.isTrue(interrupted)
        assert.strictEqual(calls.length, 2)
        const ended = outputsOfTag(outputs, "CompactionEnded")
        assert.strictEqual(ended.length, 1)
        assert.strictEqual(ended[0]!.tokensAfter, ended[0]!.tokensBefore)
      }),
  )

  for (const reason of ["threshold", "overflow"] as const) {
    it.effect(
      `sends the full prompt to an incremental provider after ${reason} compaction`,
      () =>
        Effect.gen(function* () {
          // A Codex websocket session tracks every message it has sent. The
          // rewritten prompt starts with a new summary message, so the
          // tracker must fall back to a full send by itself.
          const tracker = yield* ResponseIdTracker.make
          tracker.markParts(fatHistory.content, "stale-response")
          assert.isTrue(Option.isSome(tracker.prepareUnsafe(fatHistory)))
          let summarized = false
          const result = yield* runAgentCollect({
            history: fatHistory,
            compaction: {
              contextWindow: reason === "threshold" ? 12_000 : 1_000_000,
              reserveTokens: 2_000,
              keepRecentTokens: 9_000,
            },
            respond: (call) => {
              if (call.isSummarizer) {
                summarized = true
                return Stream.fromIterable(text("TRACKER-SUMMARY"))
              }
              if (!summarized) return Stream.fail(contextLengthError)
              assert.isTrue(
                Option.isNone(tracker.prepareUnsafe(call.prompt)),
                "the compacted prompt must be sent in full",
              )
              assertCompactedShape(call.prompt, "TRACKER-SUMMARY")
              return Stream.fromIterable(text("full prompt sent"))
            },
          })
          assert.deepStrictEqual(result.exit, Exit.succeed("full prompt sent"))
        }),
    )
  }

  // Small window so the fat history trips the threshold: 20k - 4k = 16k tokens.
  const smallWindow = {
    contextWindow: 20_000,
    reserveTokens: 4_000,
    keepRecentTokens: 9_000,
  }

  it.effect(
    "compacts before the next call once usage crosses the threshold",
    () =>
      Effect.gen(function* () {
        const dump3 = "SENTINEL-THREE " + filler("third", 30_000)
        const { exit, calls, outputs } = yield* runAgentCollect({
          history: fatHistory,
          compaction: smallWindow,
          prompt: "Now read the third log",
          executor: makeExecutor(() => Stream.succeed(dump3)),
          respond: (call, index) => {
            switch (index) {
              case 0:
                // Real call: usage says we are over the threshold.
                return Stream.fromIterable([
                  toolCall("call-3", "await readFile({ path: 'big3.log' })"),
                  finish(17_000),
                ])
              case 1:
                assertSummarizerCall(call)
                return Stream.fromIterable([
                  ...text("SUMMARY-OF-EARLIER-WORK"),
                  finish(6_000, "stop"),
                ])
              case 2:
                return Stream.fromIterable([
                  ...text("continuing after compaction"),
                  finish(9_000, "stop"),
                ])
              default:
                return Stream.die(`unexpected model call #${index}`)
            }
          },
        })

        assert.deepStrictEqual(
          exit,
          Exit.succeed("continuing after compaction"),
        )
        assert.strictEqual(calls.length, 3)
        assert.isFalse(calls[0]!.isSummarizer)
        assert.isTrue(calls[1]!.isSummarizer)
        assert.isFalse(calls[2]!.isSummarizer)

        // Summarizer input: previous turns, execute dumps truncated to 2k.
        const summarizerJson = promptJson(calls[1]!.prompt)
        assert.include(summarizerJson, "Investigate the failing build")
        assert.isBelow(
          summarizerJson.length,
          20_000,
          "execute dumps truncated in summarizer input",
        )

        // Next real call: system + summary + kept tail, not the original dumps.
        const kept = assertCompactedShape(
          calls[2]!.prompt,
          "SUMMARY-OF-EARLIER-WORK",
        )
        const keptJson = promptJson(Prompt.fromMessages(kept))
        assert.notInclude(
          keptJson,
          "SENTINEL-ONE",
          "oldest dump summarized away",
        )
        assert.include(keptJson, "call-3", "newest execute turn kept")
        assert.include(
          keptJson,
          "Now read the third log",
          "current user prompt kept",
        )
        assert.notInclude(
          promptJson(calls[2]!.prompt),
          Compaction.summaryOpenTag + Compaction.summaryOpenTag,
        )

        // Call/result pairing is intact after the rewrite.
        const ids = toolCallIds(calls[2]!.prompt)
        for (const id of new Set(ids)) {
          assert.strictEqual(
            ids.filter((x) => x === id).length,
            2,
            `pair intact for ${id}`,
          )
        }

        // Events
        const started = outputsOfTag(outputs, "CompactionStarted")
        const ended = outputsOfTag(outputs, "CompactionEnded")
        assert.strictEqual(started.length, 1)
        assert.strictEqual(started[0]!.reason, "threshold")
        assert.strictEqual(ended.length, 1)
        assert.strictEqual(ended[0]!.reason, "threshold")
        assert.isBelow(ended[0]!.tokensAfter, ended[0]!.tokensBefore)
      }),
  )

  it.effect(
    "estimates from prompt size when no usage has been seen (session load)",
    () =>
      Effect.gen(function* () {
        // fatHistory is ~15k tokens by estimate; threshold is 16k, so bump the window down.
        const { exit, calls } = yield* runAgentCollect({
          history: fatHistory,
          compaction: {
            contextWindow: 12_000,
            reserveTokens: 2_000,
            keepRecentTokens: 9_000,
          },
          prompt: "continue",
          respond: (call, index) => {
            switch (index) {
              case 0:
                assertSummarizerCall(call)
                return Stream.fromIterable(text("LOADED-SUMMARY"))
              case 1:
                return Stream.fromIterable([
                  ...text("hello again"),
                  finish(8_000, "stop"),
                ])
              default:
                return Stream.die(`unexpected model call #${index}`)
            }
          },
        })
        assert.deepStrictEqual(exit, Exit.succeed("hello again"))
        assert.strictEqual(calls.length, 2)
        const kept = assertCompactedShape(calls[1]!.prompt, "LOADED-SUMMARY")
        assert.include(promptJson(Prompt.fromMessages(kept)), "continue")
      }),
  )

  it.effect("folds the previous summary into the next compaction", () =>
    Effect.gen(function* () {
      const alreadyCompacted = Prompt.fromMessages([
        user(Compaction.wrapSummary("FIRST-SUMMARY")),
        ...fatHistory.content,
      ])
      const { exit, calls } = yield* runAgentCollect({
        history: alreadyCompacted,
        compaction: {
          contextWindow: 12_000,
          reserveTokens: 2_000,
          keepRecentTokens: 9_000,
        },
        prompt: "continue",
        respond: (call, index) => {
          switch (index) {
            case 0:
              assertSummarizerCall(call)
              assert.include(promptJson(call.prompt), "FIRST-SUMMARY")
              return Stream.fromIterable(text("SECOND-SUMMARY"))
            case 1:
              return Stream.fromIterable(text("ok"))
            default:
              return Stream.die(`unexpected model call #${index}`)
          }
        },
      })
      assert.deepStrictEqual(exit, Exit.succeed("ok"))
      const rewritten = calls[1]!.prompt
      assertCompactedShape(rewritten, "SECOND-SUMMARY")
      const wrappedCount =
        promptJson(rewritten).split(Compaction.summaryOpenTag).length - 1
      assert.strictEqual(
        wrappedCount,
        1,
        "only one summary message after re-compaction",
      )
    }),
  )

  it.effect("is a no-op when the keep tail is the whole prompt", () =>
    Effect.gen(function* () {
      const { exit, calls, outputs } = yield* runAgentCollect({
        // Tiny window but a huge keep budget: nothing to summarize.
        compaction: {
          contextWindow: 1_000,
          reserveTokens: 100,
          keepRecentTokens: 1_000_000,
        },
        respond: (_call, index) =>
          index === 0
            ? Stream.fromIterable([toolCall("call-1", "ls()"), finish(950)])
            : Stream.fromIterable(text("done")),
        executor: makeExecutor(() => Stream.succeed("files")),
      })
      assert.deepStrictEqual(exit, Exit.succeed("done"))
      assert.isTrue(
        calls.every((c) => !c.isSummarizer),
        "no summarizer call",
      )
      assert.strictEqual(outputsOfTag(outputs, "CompactionStarted").length, 0)
    }),
  )

  it.effect("does not compact when disabled", () =>
    Effect.gen(function* () {
      const { exit, calls, outputs } = yield* runAgentCollect({
        history: fatHistory,
        compaction: { ...smallWindow, enabled: false },
        respond: (_call, index) =>
          index === 0
            ? Stream.fromIterable([
                ...text("no compaction"),
                finish(17_000, "stop"),
              ])
            : Stream.die(`unexpected model call #${index}`),
      })
      assert.deepStrictEqual(exit, Exit.succeed("no compaction"))
      assert.strictEqual(calls.length, 1)
      assert.include(promptJson(calls[0]!.prompt), "SENTINEL-ONE")
      assert.strictEqual(outputsOfTag(outputs, "CompactionStarted").length, 0)
    }),
  )

  it.effect("skips a failed threshold compaction and continues the turn", () =>
    Effect.gen(function* () {
      const { exit, calls, outputs } = yield* runAgentCollect({
        history: fatHistory,
        compaction: {
          contextWindow: 12_000,
          reserveTokens: 2_000,
          keepRecentTokens: 9_000,
        },
        respond: (call, index) => {
          switch (index) {
            case 0:
              assertSummarizerCall(call)
              return Stream.fail(providerError)
            case 1:
              assert.isFalse(call.isSummarizer)
              assert.include(
                promptJson(call.prompt),
                "SENTINEL-ONE",
                "uncompacted prompt sent",
              )
              return Stream.fromIterable(text("carried on"))
            default:
              return Stream.die(`unexpected model call #${index}`)
          }
        },
      })
      assert.deepStrictEqual(exit, Exit.succeed("carried on"))
      assert.strictEqual(calls.length, 2)
      const started = outputsOfTag(outputs, "CompactionStarted")
      const ended = outputsOfTag(outputs, "CompactionEnded")
      assert.strictEqual(started.length, 1)
      assert.strictEqual(
        ended.length,
        1,
        "failed compaction must close its progress event",
      )
      assert.strictEqual(ended[0]!.reason, "threshold")
      assert.strictEqual(ended[0]!.tokensAfter, ended[0]!.tokensBefore)
    }),
  )
})

describe("Agent overflow compaction", () => {
  // Large window: the threshold never fires, only the overflow path can.
  const bigWindow = {
    contextWindow: 1_000_000,
    reserveTokens: 1_000,
    keepRecentTokens: 9_000,
  }

  it.live(
    "can compact again after a timeout interrupts the first overflow summary",
    () =>
      Effect.gen(function* () {
        let interrupted = false
        const { exit, calls } = yield* runAgentCollect({
          history: fatHistory,
          compaction: bigWindow,
          turnTimeout: Duration.millis(100),
          respond: (call, index) => {
            switch (index) {
              case 0:
                assert.isFalse(call.isSummarizer)
                assert.include(promptJson(call.prompt), "SENTINEL-ONE")
                return Stream.fail(contextLengthError)
              case 1:
                assertSummarizerCall(call)
                return Stream.fromEffect(Effect.never).pipe(
                  Stream.ensuring(
                    Effect.sync(() => {
                      interrupted = true
                    }),
                  ),
                )
              case 2:
                // The stalled summary is retried once without re-sending
                // the fat prompt.
                assertSummarizerCall(call)
                assert.isTrue(interrupted)
                return Stream.fromIterable(text("RECOVERED-SUMMARY"))
              case 3:
                assertCompactedShape(call.prompt, "RECOVERED-SUMMARY")
                return Stream.fromIterable(text("recovered after timeout"))
              default:
                return Stream.die(`unexpected model call #${index}`)
            }
          },
        }).pipe(Effect.timeout("2 seconds"))
        assert.deepStrictEqual(exit, Exit.succeed("recovered after timeout"))
        assert.strictEqual(calls.length, 4)
      }),
  )

  it.live("compacts once and retries after a context-length error", () =>
    Effect.gen(function* () {
      const { exit, calls, outputs } = yield* runAgentCollect({
        history: fatHistory,
        compaction: bigWindow,
        prompt: "continue",
        respond: (call, index) => {
          switch (index) {
            case 0:
              assert.isFalse(call.isSummarizer)
              return Stream.fail(contextLengthError)
            case 1:
              assertSummarizerCall(call)
              return Stream.fromIterable(text("OVERFLOW-SUMMARY"))
            case 2:
              assert.isFalse(call.isSummarizer)
              return Stream.fromIterable([
                ...text("recovered"),
                finish(5_000, "stop"),
              ])
            default:
              return Stream.die(`unexpected model call #${index}`)
          }
        },
      })

      assert.deepStrictEqual(exit, Exit.succeed("recovered"))
      assert.strictEqual(calls.length, 3)
      const kept = assertCompactedShape(calls[2]!.prompt, "OVERFLOW-SUMMARY")
      assert.notInclude(promptJson(Prompt.fromMessages(kept)), "SENTINEL-ONE")
      assert.include(promptJson(Prompt.fromMessages(kept)), "continue")

      const started = outputsOfTag(outputs, "CompactionStarted")
      assert.strictEqual(started.length, 1)
      assert.strictEqual(started[0]!.reason, "overflow")
      assert.strictEqual(
        outputsOfTag(outputs, "CompactionEnded")[0]?.reason,
        "overflow",
      )
    }),
  )

  it.live(
    "fails the turn when the retry after compaction overflows again",
    () =>
      Effect.gen(function* () {
        const { exit, calls } = yield* runAgentCollect({
          history: fatHistory,
          compaction: bigWindow,
          respond: (call, index) => {
            switch (index) {
              case 0:
                return Stream.fail(contextLengthError)
              case 1:
                assertSummarizerCall(call)
                return Stream.fromIterable(text("SUMMARY"))
              case 2:
                return Stream.fail(contextLengthError)
              default:
                return Stream.die(
                  `unexpected model call #${index}: must not retry forever`,
                )
            }
          },
        })
        assert.isTrue(Exit.isFailure(exit), "turn must fail")
        const error = Option.getOrThrow(Exit.findErrorOption(exit))
        assert.strictEqual(error._tag, "AiError")
        assert.strictEqual(error.reason._tag, "InvalidRequestError")
        assert.strictEqual(calls.length, 3)
      }),
  )

  it.live(
    "compacts a retryable context-length error before retrying the original prompt",
    () =>
      Effect.gen(function* () {
        const error = AiError.make({
          module: "OpenAiLanguageModel",
          method: "streamText",
          reason: new AiError.InternalProviderError({
            description: "maximum context length is 236000 tokens",
          }),
        })
        assert.isTrue(error.isRetryable)
        const { exit, calls, outputs } = yield* runAgentCollect({
          history: fatHistory,
          compaction: bigWindow,
          respond: (_call, index) => {
            switch (index) {
              case 0:
                return Stream.fail(error)
              case 1:
                return Stream.fromIterable(text("RETRYABLE-SUMMARY"))
              case 2:
                return Stream.fromIterable(text("recovered"))
              default:
                return Stream.die(`unexpected model call #${index}`)
            }
          },
        })
        assert.deepStrictEqual(
          calls.map((call) => call.isSummarizer),
          [false, true, false],
          "overflow compaction must precede any retry of the original prompt",
        )
        assert.deepStrictEqual(exit, Exit.succeed("recovered"))
        assert.include(promptJson(calls[0]!.prompt), "SENTINEL-ONE")
        assertCompactedShape(calls[2]!.prompt, "RETRYABLE-SUMMARY")
        assert.notInclude(promptJson(calls[2]!.prompt), "SENTINEL-ONE")
        assert.strictEqual(outputsOfTag(outputs, "ErrorRetry").length, 0)
        assert.strictEqual(
          outputsOfTag(outputs, "CompactionStarted")[0]?.reason,
          "overflow",
        )
      }),
  )

  it.live("fails the turn when the overflow compaction itself fails", () =>
    Effect.gen(function* () {
      const { exit, calls } = yield* runAgentCollect({
        history: fatHistory,
        compaction: bigWindow,
        respond: (call, index) => {
          switch (index) {
            case 0:
              return Stream.fail(contextLengthError)
            case 1:
              assertSummarizerCall(call)
              return Stream.fail(providerError)
            default:
              return Stream.die(`unexpected model call #${index}`)
          }
        },
      })
      assert.isTrue(Exit.isFailure(exit), "turn must fail")
      assert.strictEqual(calls.length, 2)
    }),
  )

  it.live("fails without compacting when the kill switch is on", () =>
    Effect.gen(function* () {
      const { exit, calls, outputs } = yield* runAgentCollect({
        history: fatHistory,
        compaction: { ...bigWindow, enabled: false },
        respond: (_call, index) =>
          index === 0
            ? Stream.fail(contextLengthError)
            : Stream.die(`unexpected model call #${index}`),
      })
      assert.isTrue(Exit.isFailure(exit))
      assert.strictEqual(calls.length, 1)
      assert.strictEqual(outputsOfTag(outputs, "CompactionStarted").length, 0)
    }),
  )

  it.live("retries other retryable errors without compacting", () =>
    Effect.gen(function* () {
      const { exit, calls, outputs } = yield* runAgentCollect({
        history: fatHistory,
        compaction: bigWindow,
        respond: (call, index) => {
          switch (index) {
            case 0:
              return Stream.fail(providerError)
            case 1:
              assert.isFalse(
                call.isSummarizer,
                "must not summarize on a provider error",
              )
              assert.include(
                promptJson(call.prompt),
                "SENTINEL-ONE",
                "same prompt retried",
              )
              return Stream.fromIterable(text("second try worked"))
            default:
              return Stream.die(`unexpected model call #${index}`)
          }
        },
      })
      assert.deepStrictEqual(exit, Exit.succeed("second try worked"))
      assert.strictEqual(calls.length, 2)
      assert.strictEqual(outputsOfTag(outputs, "ErrorRetry").length, 1)
      assert.strictEqual(outputsOfTag(outputs, "CompactionStarted").length, 0)
    }),
  )
})

import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as AiError from "effect/unstable/ai/AiError"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Schema from "effect/Schema"
import * as ResponseIdTracker from "effect/unstable/ai/ResponseIdTracker"
import * as Compaction from "./Compaction.ts"

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const user = (text: string) =>
  Prompt.makeMessage("user", {
    content: [Prompt.makePart("text", { text })],
  })

const assistantText = (text: string) =>
  Prompt.makeMessage("assistant", {
    content: [Prompt.makePart("text", { text })],
  })

const assistantCall = (id: string, script: string, reasoning?: string) =>
  Prompt.makeMessage("assistant", {
    content: [
      ...(reasoning === undefined
        ? []
        : [Prompt.makePart("reasoning", { text: reasoning })]),
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

const system = Prompt.makeMessage("system", { content: "You are a test." })

/** A string of `n` characters built from a recognisable repeating word. */
const filler = (word: string, n: number) =>
  (word + " ").repeat(Math.ceil(n / (word.length + 1))).slice(0, n)

const openAiError = (
  reason: AiError.AiErrorReason,
  method: string = "streamText",
) => AiError.make({ module: "OpenAiLanguageModel", method, reason })

const request = {
  method: "POST",
  url: "https://example.test/v1/responses",
  urlParams: [],
  headers: {},
} as const

const httpContext = (status: number, body: string) =>
  ({
    request,
    response: { status, headers: {} },
    body,
  }) as const

/** Mirrors `buildErrorDescription` in `@effect/ai-openai` for a 400. */
const contextDescription = (message: string, code?: string) =>
  `${message} (POST https://example.test/v1/responses)${code ? ` [code: ${code}]` : ""}`

/** Content parts of a message; system messages have none. */
const parts = (message: Prompt.Message): ReadonlyArray<Prompt.Part> =>
  typeof message.content === "string" ? [] : message.content

const toolResultText = (message: Prompt.Message): string => {
  const part = parts(message)[0]
  if (message.role !== "tool" || part?.type !== "tool-result") {
    throw new Error(`expected a tool result message, got ${message.role}`)
  }
  return part.result as string
}

const encodePrompt = Schema.encodeSync(Prompt.Prompt)

const promptText = (prompt: Prompt.Prompt): string =>
  JSON.stringify(encodePrompt(prompt))

// -----------------------------------------------------------------------------
// capOutput
// -----------------------------------------------------------------------------

describe("Compaction.capOutput", () => {
  it("returns short output unchanged", () => {
    const result = Compaction.capOutput("hello world")
    assert.strictEqual(result.output, "hello world")
    assert.isFalse(result.capped)
    assert.strictEqual(result.charsBefore, 11)
    assert.strictEqual(result.charsAfter, 11)
  })

  it("returns output exactly at the cap unchanged", () => {
    const input = "x".repeat(Compaction.executeOutputCapChars)
    const result = Compaction.capOutput(input)
    assert.strictEqual(result.output, input)
    assert.isFalse(result.capped)
  })

  it("caps output over the limit keeping head and tail with a marker", () => {
    const head = "HEAD-" + filler("alpha", 30_000)
    const tail = filler("omega", 30_000) + "-TAIL"
    const input = head + tail
    const result = Compaction.capOutput(input)

    assert.isTrue(result.capped)
    assert.strictEqual(result.charsBefore, input.length)
    assert.strictEqual(result.charsAfter, result.output.length)
    // Marker overhead stays small: well under one extra kilobyte.
    assert.isAtMost(
      result.output.length,
      Compaction.executeOutputCapChars + 1_000,
    )
    assert.isAtLeast(
      result.output.length,
      Compaction.executeOutputCapChars - 1_000,
    )
    assert.isTrue(result.output.startsWith("HEAD-"))
    assert.isTrue(result.output.endsWith("-TAIL"))
  })

  it("marker tells the model how much was dropped and how to narrow the read", () => {
    const input = filler("line", 40_000)
    const result = Compaction.capOutput(input)
    assert.include(result.output, "startLine")
    assert.include(result.output, "endLine")
    assert.include(result.output, String(input.length))
  })

  it("respects a custom cap", () => {
    const input = filler("word", 5_000)
    const result = Compaction.capOutput(input, 1_000)
    assert.isTrue(result.capped)
    assert.isAtMost(result.output.length, 1_000 + 1_000)
    assert.isBelow(result.output.length, input.length)
  })
})

// -----------------------------------------------------------------------------
// Token estimates and threshold
// -----------------------------------------------------------------------------

describe("Compaction.estimateTokens", () => {
  it("estimates roughly a quarter of the encoded JSON length", () => {
    const prompt = Prompt.fromMessages([
      user("hi"),
      assistantCall("c1", "ls()"),
      toolResult("c1", filler("file", 40_000)),
    ])
    const jsonLength = promptText(prompt).length
    const estimate = Compaction.estimateTokens(prompt)
    assert.isAtLeast(estimate, Math.floor(jsonLength / 4) - 1)
    assert.isAtMost(estimate, Math.ceil(jsonLength / 4) + 1)
  })

  it("message estimates add up to about the prompt estimate", () => {
    const messages = [
      user("hi"),
      assistantCall("c1", "ls()"),
      toolResult("c1", filler("f", 2_000)),
    ]
    const sum = messages.reduce(
      (n, m) => n + Compaction.estimateMessageTokens(m),
      0,
    )
    const total = Compaction.estimateTokens(Prompt.fromMessages(messages))
    assert.isAtMost(Math.abs(sum - total), 8)
  })
})

describe("Compaction.CompactionConfig", () => {
  it.effect("defaults to a 236k window with a 16k reserve", () =>
    Effect.gen(function* () {
      const config = yield* Compaction.CompactionConfig
      assert.deepStrictEqual(Compaction.defaultConfig, {
        enabled: true,
        contextWindow: 236_000,
        reserveTokens: 16_000,
        keepRecentTokens: 20_000,
      })
      assert.deepStrictEqual(config, Compaction.defaultConfig)
    }),
  )
})

describe("Compaction.shouldCompact", () => {
  const config = {
    ...Compaction.defaultConfig,
    contextWindow: 1_000,
    reserveTokens: 100,
  }
  const small = Prompt.fromMessages([user("hi")])

  for (const [tokens, expected] of [
    [219_999, false],
    [220_000, false],
    [220_001, true],
  ] as const) {
    it(`returns ${expected} with default config and ${tokens} reported tokens`, () => {
      assert.strictEqual(
        Compaction.shouldCompact({
          prompt: small,
          contextTokens: tokens,
          config: Compaction.defaultConfig,
        }),
        expected,
      )
    })

    it(`returns ${expected} with default config and ${tokens} estimated tokens`, () => {
      const empty = Prompt.fromMessages([user("")])
      const prompt = Prompt.fromMessages([
        user("x".repeat(tokens * 4 - promptText(empty).length)),
      ])
      assert.strictEqual(Compaction.estimateTokens(prompt), tokens)
      assert.strictEqual(
        Compaction.shouldCompact({
          prompt,
          contextTokens: undefined,
          config: Compaction.defaultConfig,
        }),
        expected,
      )
    })
  }

  it("fires when the last contextTokens exceeds contextWindow - reserveTokens", () => {
    assert.isTrue(
      Compaction.shouldCompact({ prompt: small, contextTokens: 901, config }),
    )
  })

  it("does not fire at or below the threshold", () => {
    assert.isFalse(
      Compaction.shouldCompact({ prompt: small, contextTokens: 900, config }),
    )
    assert.isFalse(
      Compaction.shouldCompact({ prompt: small, contextTokens: 10, config }),
    )
  })

  it("uses the prompt estimate when there is no usage yet", () => {
    const fat = Prompt.fromMessages([user(filler("word", 10_000))])
    assert.isTrue(
      Compaction.shouldCompact({
        prompt: fat,
        contextTokens: undefined,
        config,
      }),
    )
    assert.isFalse(
      Compaction.shouldCompact({
        prompt: small,
        contextTokens: undefined,
        config,
      }),
    )
  })

  it("never fires when disabled", () => {
    assert.isFalse(
      Compaction.shouldCompact({
        prompt: small,
        contextTokens: 100_000,
        config: { ...config, enabled: false },
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Overflow detection
// -----------------------------------------------------------------------------

describe("Compaction.isContextLengthError", () => {
  it("matches the Codex context window error", () => {
    const error = openAiError(
      new AiError.InvalidRequestError({
        description: contextDescription(
          "Your input exceeds the context window of this model. Please adjust your input and try again.",
          "context_length_exceeded",
        ),
        http: httpContext(400, ""),
      }),
    )
    assert.isTrue(Compaction.isContextLengthError(error))
  })

  it("matches the Copilot / OpenAI-compatible maximum context length error", () => {
    const error = openAiError(
      new AiError.InvalidRequestError({
        description: contextDescription(
          "This model's maximum context length is 128000 tokens. However, your messages resulted in 131072 tokens.",
          "context_length_exceeded",
        ),
      }),
    )
    assert.isTrue(Compaction.isContextLengthError(error))
  })

  it("matches the context_length_exceeded code even with an unfamiliar message", () => {
    const error = openAiError(
      new AiError.InvalidRequestError({
        description: contextDescription(
          "Bad request",
          "context_length_exceeded",
        ),
        metadata: { openai: { errorCode: "context_length_exceeded" } } as never,
      }),
    )
    assert.isTrue(Compaction.isContextLengthError(error))
  })

  it("matches a 413 prompt-too-large error mapped to UnknownError", () => {
    const error = openAiError(
      new AiError.UnknownError({
        description: "prompt token count of 200000 exceeds the limit of 128000",
        http: httpContext(413, ""),
      }),
    )
    assert.isTrue(Compaction.isContextLengthError(error))
  })

  it("does not match other invalid requests", () => {
    const error = openAiError(
      new AiError.InvalidRequestError({
        parameter: "temperature",
        description: contextDescription(
          "Invalid value for temperature",
          "invalid_value",
        ),
      }),
    )
    assert.isFalse(Compaction.isContextLengthError(error))
  })

  it("does not match retryable transport or provider errors", () => {
    assert.isFalse(
      Compaction.isContextLengthError(
        openAiError(
          new AiError.InternalProviderError({ description: "Server error" }),
        ),
      ),
    )
    assert.isFalse(
      Compaction.isContextLengthError(
        openAiError(new AiError.RateLimitError({})),
      ),
    )
    assert.isFalse(
      Compaction.isContextLengthError(
        openAiError(
          new AiError.NetworkError({
            reason: "TransportError",
            request,
            description: "socket timeout",
          }),
        ),
      ),
    )
  })
})

// -----------------------------------------------------------------------------
// Cut points
// -----------------------------------------------------------------------------

describe("Compaction.split", () => {
  // Each execute result is ~8k chars => ~2k tokens per tool message.
  const dump = (i: number) => filler(`dump${i}`, 8_000)
  const conversation = [
    user("first request"),
    assistantCall("c1", "readFile(1)"),
    toolResult("c1", dump(1)),
    assistantCall("c2", "readFile(2)"),
    toolResult("c2", dump(2)),
    assistantCall("c3", "readFile(3)"),
    toolResult("c3", dump(3)),
  ]

  it("returns None when the keep tail is the whole prompt", () => {
    const prompt = Prompt.fromMessages([system, ...conversation])
    assert.isTrue(Option.isNone(Compaction.split(prompt, 1_000_000)))
  })

  it("returns None for an empty or system-only prompt", () => {
    assert.isTrue(Option.isNone(Compaction.split(Prompt.empty, 10)))
    assert.isTrue(
      Option.isNone(Compaction.split(Prompt.fromMessages([system]), 10)),
    )
  })

  it("keeps the most recent messages that fit and summarizes the rest", () => {
    const prompt = Prompt.fromMessages([system, ...conversation])
    // Each pair is ~2.1k tokens: 5k fits the last two pairs but not three.
    const result = Option.getOrThrow(Compaction.split(prompt, 5_000))

    assert.isTrue(Option.isSome(result.system))
    assert.strictEqual(Option.getOrThrow(result.system).role, "system")
    assert.isTrue(Option.isNone(result.previousSummary))
    assert.deepStrictEqual(
      result.kept.map((m) => m.role),
      ["assistant", "tool", "assistant", "tool"],
    )
    assert.deepStrictEqual(result.toSummarize, conversation.slice(0, 3))
    assert.deepStrictEqual(result.kept, conversation.slice(3))
  })

  it("never splits an execute call from its result", () => {
    const prompt = Prompt.fromMessages([system, ...conversation])
    // Budget fits the last tool result but not its assistant call: the call
    // must be pulled into the kept tail rather than the result orphaned.
    const lastResultTokens = Compaction.estimateMessageTokens(conversation[6]!)
    const result = Option.getOrThrow(
      Compaction.split(prompt, lastResultTokens + 5),
    )

    assert.strictEqual(result.kept[0]!.role, "assistant")
    const call = parts(result.kept[0]!).find((p) => p.type === "tool-call")
    assert.isDefined(call)
    assert.strictEqual((call as Prompt.ToolCallPart).id, "c3")
    assert.strictEqual(result.kept.length, 2)
    assert.strictEqual(result.toSummarize.length, 5)
  })

  it("always keeps at least the newest complete unit", () => {
    const prompt = Prompt.fromMessages([system, ...conversation])
    const result = Option.getOrThrow(Compaction.split(prompt, 1))
    assert.deepStrictEqual(result.kept, conversation.slice(5))
    assert.deepStrictEqual(result.toSummarize, conversation.slice(0, 5))
  })

  it("does not leave a tool message at the head of the kept tail", () => {
    for (const budget of [1, 500, 2_000, 3_000, 5_000, 9_000, 20_000]) {
      const prompt = Prompt.fromMessages([system, ...conversation])
      const result = Compaction.split(prompt, budget)
      if (Option.isNone(result)) continue
      assert.notStrictEqual(
        result.value.kept[0]!.role,
        "tool",
        `budget ${budget}`,
      )
      assert.strictEqual(
        result.value.toSummarize.length + result.value.kept.length,
        conversation.length,
      )
    }
  })

  it("excludes a previous summary message and exposes its text", () => {
    const previous = "Earlier we investigated the build."
    const prompt = Prompt.fromMessages([
      system,
      user(Compaction.wrapSummary(previous)),
      ...conversation,
    ])
    const result = Option.getOrThrow(Compaction.split(prompt, 5_000))
    assert.deepStrictEqual(result.previousSummary, Option.some(previous))
    assert.deepStrictEqual(result.toSummarize, conversation.slice(0, 3))
    assert.isFalse(
      result.toSummarize.some((m) =>
        promptText(Prompt.fromMessages([m])).includes(previous),
      ),
    )
  })

  it("returns None when only the previous summary would be summarized", () => {
    const prompt = Prompt.fromMessages([
      system,
      user(Compaction.wrapSummary("old summary")),
      ...conversation.slice(5),
    ])
    assert.isTrue(Option.isNone(Compaction.split(prompt, 1_000_000)))
  })
})

describe("Compaction.findPreviousSummary", () => {
  it("finds the wrapped summary user message", () => {
    const prompt = Prompt.fromMessages([
      system,
      user(Compaction.wrapSummary("the summary")),
      user("next"),
    ])
    assert.deepStrictEqual(
      Compaction.findPreviousSummary(prompt),
      Option.some("the summary"),
    )
  })

  it("returns None when there is no summary", () => {
    const prompt = Prompt.fromMessages([system, user("plain")])
    assert.isTrue(Option.isNone(Compaction.findPreviousSummary(prompt)))
  })
})

describe("Compaction.trimKept", () => {
  it("returns the tail unchanged when it fits", () => {
    const kept = [
      assistantCall("c1", "ls()", "thinking"),
      toolResult("c1", "ok"),
    ]
    assert.deepStrictEqual(Compaction.trimKept(kept, 10_000), kept)
  })

  it("drops reasoning from the oldest assistant messages first", () => {
    const kept = [
      assistantCall("c1", "ls()", filler("think", 4_000)),
      toolResult("c1", "ok"),
      assistantCall("c2", "ls()", filler("think", 4_000)),
      toolResult("c2", "ok"),
    ]
    // Budget: everything fits once the oldest reasoning block is gone, so
    // exactly one reasoning block must be dropped.
    const budget =
      Compaction.estimateMessageTokens(assistantCall("c1", "ls()")) +
      Compaction.estimateMessageTokens(kept[1]!) +
      Compaction.estimateMessageTokens(kept[2]!) +
      Compaction.estimateMessageTokens(kept[3]!)
    const trimmed = Compaction.trimKept(kept, budget)

    assert.strictEqual(trimmed.length, 4)
    assert.isFalse(
      parts(trimmed[0]!).some((p) => p.type === "reasoning"),
      "oldest reasoning dropped",
    )
    assert.isTrue(
      parts(trimmed[2]!).some((p) => p.type === "reasoning"),
      "newest reasoning kept",
    )
    assert.isTrue(
      parts(trimmed[0]!).some((p) => p.type === "tool-call" && p.id === "c1"),
    )
    assert.isTrue(
      parts(trimmed[2]!).some((p) => p.type === "tool-call" && p.id === "c2"),
    )
  })

  it("stubs oversized execute results in place after reasoning is gone", () => {
    const big = "START-" + filler("result", 60_000) + "-END"
    const kept = [
      assistantCall("c1", "readFile()", filler("think", 2_000)),
      toolResult("c1", big),
      assistantCall("c2", "ls()"),
      toolResult("c2", "small"),
    ]
    const trimmed = Compaction.trimKept(kept, 1_000)

    assert.strictEqual(trimmed.length, 4)
    assert.deepStrictEqual(
      trimmed.map((m) => m.role),
      ["assistant", "tool", "assistant", "tool"],
    )
    assert.isFalse(parts(trimmed[0]!).some((p) => p.type === "reasoning"))
    const stubbed = toolResultText(trimmed[1]!)
    assert.isBelow(stubbed.length, big.length)
    assert.isAtMost(stubbed.length, Compaction.keptToolResultStubChars + 1_000)
    assert.include(stubbed, "startLine")
    assert.strictEqual(toolResultText(trimmed[3]!), "small")
    // Pairing preserved: ids unchanged and in order.
    const ids = trimmed.flatMap((m) =>
      parts(m).flatMap((p) =>
        p.type === "tool-call" || p.type === "tool-result" ? [p.id] : [],
      ),
    )
    assert.deepStrictEqual(ids, ["c1", "c1", "c2", "c2"])
  })

  it("never removes or reorders messages", () => {
    const kept = [
      user("u"),
      assistantCall("c1", "a()", filler("r", 10_000)),
      toolResult("c1", filler("x", 50_000)),
      assistantText("done"),
    ]
    const trimmed = Compaction.trimKept(kept, 10)
    assert.deepStrictEqual(
      trimmed.map((m) => m.role),
      ["user", "assistant", "tool", "assistant"],
    )
  })
})

// -----------------------------------------------------------------------------
// Prompt rewrite
// -----------------------------------------------------------------------------

describe("Compaction.summarizerPrompt", () => {
  const messages = [
    user("Please fix the failing build"),
    assistantCall("c1", "await bash('pnpm test')", "SECRET-REASONING-TEXT"),
    toolResult("c1", "LOG-START " + filler("verbose", 10_000) + " LOG-END"),
    assistantText("The tests fail because of a missing import."),
  ]

  it("renders the conversation for the summarizer without reasoning", () => {
    const prompt = Compaction.summarizerPrompt({
      previousSummary: Option.none(),
      messages,
    })
    const text = promptText(prompt)
    assert.include(text, "Please fix the failing build")
    assert.include(text, "missing import")
    assert.notInclude(text, "SECRET-REASONING-TEXT")
    assert.isFalse(
      prompt.content.some((m) => parts(m).some((p) => p.type === "reasoning")),
    )
  })

  it("caps execute results to the summarizer limit", () => {
    const prompt = Compaction.summarizerPrompt({
      previousSummary: Option.none(),
      messages,
    })
    const text = promptText(prompt)
    assert.include(text, "LOG-START")
    assert.isBelow(text.length, 10_000)
    assert.include(text, "startLine")
  })

  it("folds in the previous summary", () => {
    const prompt = Compaction.summarizerPrompt({
      previousSummary: Option.some("PREVIOUS-SUMMARY-BODY"),
      messages,
    })
    assert.include(promptText(prompt), "PREVIOUS-SUMMARY-BODY")
  })

  it("does not carry the agent tools or system prompt", () => {
    const prompt = Compaction.summarizerPrompt({
      previousSummary: Option.none(),
      messages,
    })
    assert.isFalse(prompt.content.some((m) => m.role === "tool"))
    assert.isTrue(prompt.content.some((m) => m.role === "user"))
  })
})

describe("Compaction.wrapSummary", () => {
  it("wraps in the compaction-summary tags", () => {
    const wrapped = Compaction.wrapSummary("body")
    assert.isTrue(wrapped.startsWith(Compaction.summaryOpenTag))
    assert.isTrue(wrapped.endsWith(Compaction.summaryCloseTag))
    assert.include(wrapped, "body")
  })
})

describe("Compaction.rewrite", () => {
  const kept = [
    assistantCall("c9", "ls()"),
    toolResult("c9", "files"),
    user("what next?"),
  ]

  it("produces system + summary user message + kept tail", () => {
    const prompt = Compaction.rewrite({
      system: Option.some(system),
      summary: "We did things.",
      kept,
    })
    assert.strictEqual(prompt.content.length, 2 + kept.length)
    assert.strictEqual(prompt.content[0], system)
    const summary = prompt.content[1]!
    assert.strictEqual(summary.role, "user")
    assert.strictEqual(parts(summary).length, 1)
    const part = parts(summary)[0]!
    assert.strictEqual(part.type, "text")
    assert.strictEqual(
      (part as Prompt.TextPart).text,
      Compaction.wrapSummary("We did things."),
    )
    assert.deepStrictEqual(prompt.content.slice(2), kept)
  })

  it("omits the system message when there is none", () => {
    const prompt = Compaction.rewrite({
      system: Option.none(),
      summary: "s",
      kept,
    })
    assert.strictEqual(prompt.content[0]!.role, "user")
    assert.strictEqual(prompt.content.length, 1 + kept.length)
  })

  it("is discoverable by the next compaction", () => {
    const prompt = Compaction.rewrite({
      system: Option.some(system),
      summary: "again",
      kept,
    })
    assert.deepStrictEqual(
      Compaction.findPreviousSummary(prompt),
      Option.some("again"),
    )
    const next = Option.getOrThrow(Compaction.split(prompt, 1))
    assert.deepStrictEqual(next.previousSummary, Option.some("again"))
    assert.isFalse(
      next.toSummarize.some((m) =>
        promptText(Prompt.fromMessages([m])).includes("again"),
      ),
    )
  })

  it.effect("forces a full prompt on Codex websocket sessions", () =>
    Effect.gen(function* () {
      // Simulate an incremental session: every message so far was sent and
      // tracked against a previous response id.
      const tracker = yield* ResponseIdTracker.make
      const history = [
        system,
        user("hi"),
        assistantCall("c1", "ls()"),
        toolResult("c1", "ok"),
        assistantText("done"),
      ]
      tracker.markParts(history, "resp_1")
      const nextUser = user("continue")
      const incremental = tracker.prepareUnsafe(
        Prompt.fromMessages([...history, nextUser]),
      )
      assert.isTrue(
        Option.isSome(incremental),
        "sanity: incremental send works before compaction",
      )

      const compacted = Compaction.rewrite({
        system: Option.some(system),
        summary: "we listed files",
        kept: [...history.slice(2), nextUser],
      })
      const prepared = tracker.prepareUnsafe(compacted)
      assert.isTrue(
        Option.isNone(prepared),
        "compacted prompt must be sent in full",
      )
    }),
  )
})

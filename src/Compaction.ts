/**
 * Context compaction for the shared Agent loop.
 *
 * Two independent mechanisms live here:
 *
 * 1. An always-on cap on `execute` results before they enter the Prompt
 *    (`capOutput`). It runs on every surface and is not affected by the
 *    compaction kill switch.
 * 2. Auto-compaction of the live Prompt (`compactIfNeeded` before a model
 *    call, `compactAfterOverflow` after a context-length error). Both rewrite
 *    the Prompt to `system + <compaction-summary> user message + kept tail`.
 *
 * @since 1.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as AiError from "effect/unstable/ai/AiError"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Prompt from "effect/unstable/ai/Prompt"

// =============================================================================
// Configuration
// =============================================================================

/**
 * Runtime configuration for auto-compaction.
 *
 * - `enabled`: kill switch for both compact paths. Does **not** disable the
 *   `execute` output cap.
 * - `contextWindow`: assumed model context window in tokens.
 * - `reserveTokens`: headroom kept free below `contextWindow`. Compaction
 *   triggers once the last reported `contextTokens` (or the estimate) exceeds
 *   `contextWindow - reserveTokens`.
 * - `keepRecentTokens`: size of the recent tail preserved verbatim after a
 *   compaction.
 *
 * @since 1.0.0
 * @category Configuration
 */
export interface CompactionConfigService {
  readonly enabled: boolean
  readonly contextWindow: number
  readonly reserveTokens: number
  readonly keepRecentTokens: number
}

/**
 * @since 1.0.0
 * @category Configuration
 */
export const defaultConfig: CompactionConfigService = {
  enabled: true,
  contextWindow: 236_000,
  reserveTokens: 16_000,
  keepRecentTokens: 20_000,
}

/**
 * @since 1.0.0
 * @category Configuration
 */
export class CompactionConfig extends Context.Reference<CompactionConfigService>(
  "clanka/Compaction/CompactionConfig",
  { defaultValue: () => defaultConfig },
) {
  static readonly layer = (
    options: Partial<CompactionConfigService>,
  ): Layer.Layer<never> =>
    Layer.succeed(CompactionConfig, { ...defaultConfig, ...options })
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Hard cap, in characters, applied to every `execute` success string before it
 * is appended to the Prompt. Always on.
 *
 * @since 1.0.0
 * @category Constants
 */
export const executeOutputCapChars = 32_000

/**
 * Cap applied to `execute` results when they are rendered into the summarizer
 * input.
 *
 * @since 1.0.0
 * @category Constants
 */
export const summarizerToolResultCapChars = 2_000

/**
 * Cap applied to `execute` results that remain in the kept tail when the tail
 * itself still exceeds `keepRecentTokens` after reasoning has been dropped.
 *
 * @since 1.0.0
 * @category Constants
 */
export const keptToolResultStubChars = 2_000

/**
 * Maximum output tokens requested by providers that support a summary cap.
 * Copilot uses this limit; Codex rejects max_output_tokens and has no
 * configured summary output-token cap.
 *
 * @since 1.0.0
 * @category Constants
 */
export const summarizerMaxOutputTokens = 4_000

/**
 * The synthetic summary user message is wrapped in these tags so a later
 * compaction can locate it without a new Prompt schema.
 *
 * @since 1.0.0
 * @category Constants
 */
export const summaryOpenTag = "<compaction-summary>"

/**
 * @since 1.0.0
 * @category Constants
 */
export const summaryCloseTag = "</compaction-summary>"

/**
 * System prompt included in the summarizer's Prompt.
 *
 * @since 1.0.0
 * @category Constants
 */
export const summarizerSystem = `You compact the conversation history of a coding agent so the agent can continue with less context.
Reply with the summary only. No preamble, no commentary, no markdown fences.`

// =============================================================================
// Execute output cap
// =============================================================================

/**
 * @since 1.0.0
 * @category Cap
 */
export interface CapResult {
  /**
   * The (possibly capped) output. When capped this is `head + marker + tail`,
   * where the marker tells the model how many characters were removed and
   * to narrow the read (`readFile` `startLine`/`endLine`, smaller logs).
   */
  readonly output: string
  readonly capped: boolean
  readonly charsBefore: number
  readonly charsAfter: number
}

/**
 * Cap a string to `maxChars` characters, keeping the head and the tail and
 * inserting a marker in between. Inputs at or under the cap are returned
 * unchanged.
 *
 * @since 1.0.0
 * @category Cap
 */
export const capOutput = (
  output: string,
  maxChars: number = executeOutputCapChars,
): CapResult => {
  const charsBefore = output.length
  if (charsBefore <= maxChars) {
    return { output, capped: false, charsBefore, charsAfter: charsBefore }
  }
  const headChars = Math.floor(maxChars / 2)
  const tailChars = maxChars - headChars
  const omitted = charsBefore - maxChars
  const marker =
    `\n\n[... output capped: ${omitted} of ${charsBefore} chars omitted from the middle. ` +
    `Do not re-run this as is. Narrow the read instead: use readFile with startLine/endLine, ` +
    `search for what you need, or print smaller logs ...]\n\n`
  const capped =
    output.slice(0, headChars) + marker + output.slice(charsBefore - tailChars)
  return {
    output: capped,
    capped: true,
    charsBefore,
    charsAfter: capped.length,
  }
}

// =============================================================================
// Token accounting
// =============================================================================

const encodePrompt = Schema.encodeSync(Prompt.Prompt)
const encodeMessage = Schema.encodeSync(Prompt.Message)

/**
 * Cheap token estimate for a Prompt: encoded JSON length / 4. Used when no
 * `contextTokens` usage has been observed yet (first turn, ACP session load)
 * and for sizing the kept tail.
 *
 * @since 1.0.0
 * @category Tokens
 */
export const estimateTokens = (prompt: Prompt.Prompt): number =>
  Math.ceil(JSON.stringify(encodePrompt(prompt)).length / 4)

/**
 * Token estimate for a single message. Same measure as `estimateTokens`.
 *
 * @since 1.0.0
 * @category Tokens
 */
export const estimateMessageTokens = (message: Prompt.Message): number =>
  Math.ceil(JSON.stringify(encodeMessage(message)).length / 4)

/**
 * Whether the threshold trigger fires for the next model call.
 *
 * `contextTokens` is the `inputTokens.total` from the most recent `finish`
 * part, or `undefined` when no usage has been observed yet, in which case
 * `estimateTokens(prompt)` is used instead.
 *
 * Always `false` when `config.enabled` is `false`.
 *
 * @since 1.0.0
 * @category Tokens
 */
export const shouldCompact = (options: {
  readonly prompt: Prompt.Prompt
  readonly contextTokens: number | undefined
  readonly config: CompactionConfigService
}): boolean => {
  if (!options.config.enabled) return false
  const tokens = options.contextTokens ?? estimateTokens(options.prompt)
  return tokens > options.config.contextWindow - options.config.reserveTokens
}

// =============================================================================
// Overflow detection
// =============================================================================

const contextLengthPattern =
  /context[_ ]?(length|window)|maximum context length|too many tokens|prompt is too long|prompt token count|exceeds the (context|token|input )?limit|input token limit|exceeds the model'?s? (context|token|input)/i

const openAiErrorCode = (reason: {
  readonly metadata?: unknown
}): string | undefined => {
  const metadata = reason.metadata
  if (
    Predicate.hasProperty(metadata, "errorCode") &&
    Predicate.isString(metadata.errorCode)
  ) {
    return metadata.errorCode
  }
  if (!Predicate.hasProperty(metadata, "openai")) return undefined
  const openai = metadata.openai
  if (!Predicate.hasProperty(openai, "errorCode")) return undefined
  return Predicate.isString(openai.errorCode) ? openai.errorCode : undefined
}

/**
 * Whether an `AiError` is a context-length overflow from a known provider
 * (Codex / Copilot), as opposed to any other request or transport failure.
 *
 * Only these errors trigger `compactAfterOverflow`; other retryable errors go
 * through the normal retry policy without compacting.
 *
 * @since 1.0.0
 * @category Overflow
 */
export const isContextLengthError = (error: AiError.AiError): boolean => {
  const reason = error.reason
  switch (reason._tag) {
    case "InvalidRequestError":
    case "UnknownError": {
      if (reason.http?.response?.status === 413) return true
      if (openAiErrorCode(reason) === "context_length_exceeded") return true
      return (
        reason.description !== undefined &&
        contextLengthPattern.test(reason.description)
      )
    }
    case "InternalProviderError":
      return openAiErrorCode(reason) === "context_length_exceeded"
    default:
      return false
  }
}

// =============================================================================
// Cut points
// =============================================================================

/**
 * The result of choosing a cut point in a Prompt.
 *
 * - `system`: the system message, passed through unchanged.
 * - `previousSummary`: the text inside an existing `<compaction-summary>`
 *   message, if the prompt was compacted before. That message is excluded from
 *   `toSummarize`.
 * - `toSummarize`: the messages older than the cut point.
 * - `kept`: the messages at and after the cut point, preserved verbatim
 *   (subject to `trimKept`).
 *
 * @since 1.0.0
 * @category Cut points
 */
export interface Split {
  readonly system: Option.Option<Prompt.SystemMessage>
  readonly previousSummary: Option.Option<string>
  readonly toSummarize: ReadonlyArray<Prompt.Message>
  readonly kept: ReadonlyArray<Prompt.Message>
}

const summaryText = (message: Prompt.Message): Option.Option<string> => {
  if (message.role !== "user" || message.content.length !== 1) {
    return Option.none()
  }
  const part = message.content[0]!
  if (part.type !== "text") return Option.none()
  const text = part.text.trim()
  if (!text.startsWith(summaryOpenTag) || !text.endsWith(summaryCloseTag)) {
    return Option.none()
  }
  return Option.some(
    text
      .slice(summaryOpenTag.length, text.length - summaryCloseTag.length)
      .trim(),
  )
}

/**
 * Peel the system message and a previous summary off a prompt, returning the
 * remaining conversation messages.
 */
const peel = (prompt: Prompt.Prompt) => {
  let system = Option.none<Prompt.SystemMessage>()
  let previousSummary = Option.none<string>()
  const messages: Array<Prompt.Message> = []
  for (const message of prompt.content) {
    if (message.role === "system") {
      if (Option.isNone(system)) system = Option.some(message)
      continue
    }
    if (messages.length === 0 && Option.isNone(previousSummary)) {
      const summary = summaryText(message)
      if (Option.isSome(summary)) {
        previousSummary = summary
        continue
      }
    }
    messages.push(message)
  }
  return { system, previousSummary, messages }
}

/**
 * Choose the cut point for a compaction.
 *
 * Walks back from the newest message, accumulating `estimateMessageTokens`,
 * and stops at the first message boundary where the accumulated tail would
 * exceed `keepRecentTokens`. The cut is then adjusted so that an `execute`
 * tool-call (assistant message) and its tool-result (tool message) are never
 * separated: if the boundary falls between them the assistant message is kept
 * as well. The kept tail always contains at least the newest complete unit.
 *
 * Returns `None` when there is nothing to summarize, which happens when the
 * kept tail is the whole prompt (ignoring the system message and a previous
 * summary message). Callers treat `None` as a no-op.
 *
 * @since 1.0.0
 * @category Cut points
 */
export const split = (
  prompt: Prompt.Prompt,
  keepRecentTokens: number,
): Option.Option<Split> => {
  const { system, previousSummary, messages } = peel(prompt)
  if (messages.length === 0) return Option.none()

  let cut = messages.length
  let tokens = 0
  while (cut > 0) {
    const messageTokens = estimateMessageTokens(messages[cut - 1]!)
    // Always keep the newest message, even when it alone exceeds the budget.
    if (cut < messages.length && tokens + messageTokens > keepRecentTokens) {
      break
    }
    tokens += messageTokens
    cut--
  }
  // Never leave a tool result without its call at the head of the tail.
  while (cut > 0 && messages[cut]!.role === "tool") {
    cut--
  }
  if (cut === 0) return Option.none()

  return Option.some({
    system,
    previousSummary,
    toSummarize: messages.slice(0, cut),
    kept: messages.slice(cut),
  })
}

/**
 * Find the text of a previous compaction summary in a Prompt, if present.
 *
 * @since 1.0.0
 * @category Cut points
 */
export const findPreviousSummary = (
  prompt: Prompt.Prompt,
): Option.Option<string> => peel(prompt).previousSummary

/**
 * Shrink a kept tail that still exceeds `keepRecentTokens`:
 *
 * 1. Drop `reasoning` parts from assistant messages, oldest first, until the
 *    tail fits.
 * 2. If it still does not fit, stub `execute` tool-result strings in place,
 *    oldest first, using `capOutput(result, keptToolResultStubChars)`.
 *
 * Message order, message count and tool-call / tool-result ids are never
 * changed, so call/result pairing stays valid. Returns the input unchanged
 * when it already fits.
 *
 * @since 1.0.0
 * @category Cut points
 */
export const trimKept = (
  kept: ReadonlyArray<Prompt.Message>,
  keepRecentTokens: number,
): ReadonlyArray<Prompt.Message> => {
  const sizes = kept.map(estimateMessageTokens)
  let total = sizes.reduce((n, size) => n + size, 0)
  if (total <= keepRecentTokens) return kept

  const result = kept.slice()
  const replace = (index: number, message: Prompt.Message) => {
    result[index] = message
    const size = estimateMessageTokens(message)
    total += size - sizes[index]!
    sizes[index] = size
  }

  for (let i = 0; i < result.length; i++) {
    if (total <= keepRecentTokens) break
    const message = result[i]!
    if (
      message.role !== "assistant" ||
      !message.content.some((part) => part.type === "reasoning")
    ) {
      continue
    }
    replace(
      i,
      Prompt.makeMessage("assistant", {
        content: message.content.filter((part) => part.type !== "reasoning"),
        options: message.options,
      }),
    )
  }

  for (let i = 0; i < result.length; i++) {
    if (total <= keepRecentTokens) break
    const message = result[i]!
    if (message.role !== "tool") continue
    let changed = false
    const content = message.content.map((part) => {
      if (
        part.type !== "tool-result" ||
        typeof part.result !== "string" ||
        part.result.length <= keptToolResultStubChars
      ) {
        return part
      }
      changed = true
      return Prompt.makePart("tool-result", {
        id: part.id,
        name: part.name,
        isFailure: part.isFailure,
        providerExecuted: part.providerExecuted,
        result: capOutput(part.result, keptToolResultStubChars).output,
        options: part.options,
      })
    })
    if (changed) {
      replace(
        i,
        Prompt.makeMessage("tool", { content, options: message.options }),
      )
    }
  }

  return result
}

// =============================================================================
// Prompt rewrite
// =============================================================================

const renderResult = (result: unknown): string => {
  const text = typeof result === "string" ? result : JSON.stringify(result)
  return capOutput(text ?? "", summarizerToolResultCapChars).output
}

const renderMessage = (message: Prompt.Message): string => {
  switch (message.role) {
    case "system":
      return ""
    case "user": {
      const text = message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
      return `[user]\n${text}`
    }
    case "assistant": {
      const lines: Array<string> = []
      for (const part of message.content) {
        switch (part.type) {
          case "text":
            lines.push(part.text)
            break
          case "tool-call": {
            const params = part.params as { readonly script?: unknown }
            const script =
              typeof params?.script === "string"
                ? params.script
                : JSON.stringify(part.params)
            lines.push(`[executed script]\n${script}`)
            break
          }
          default:
            break
        }
      }
      return `[assistant]\n${lines.join("\n")}`
    }
    case "tool": {
      const lines = message.content.flatMap((part) =>
        part.type === "tool-result"
          ? [
              `[script output${part.isFailure ? " (error)" : ""}]\n${renderResult(part.result)}`,
            ]
          : [],
      )
      return lines.join("\n")
    }
  }
}

/**
 * Build the Prompt sent to the summarizer model call.
 *
 * The conversation is rendered as text using the OpenCode-style summary
 * template. `reasoning` parts are omitted, `execute` tool results are capped
 * to `summarizerToolResultCapChars`, and `previousSummary` is folded in so the
 * new summary supersedes it. No tools, no system prompt from the agent.
 *
 * @since 1.0.0
 * @category Rewrite
 */
export const summarizerPrompt = (options: {
  readonly previousSummary: Option.Option<string>
  readonly messages: ReadonlyArray<Prompt.Message>
}): Prompt.Prompt => {
  const conversation = options.messages
    .map(renderMessage)
    .filter((text) => text.length > 0)
    .join("\n\n")

  const previous = Option.match(options.previousSummary, {
    onNone: () => "",
    onSome: (
      summary,
    ) => `A previous summary already covers the conversation before the messages below. Fold it into the new summary so nothing is lost:

<previous-summary>
${summary}
</previous-summary>

`,
  })

  const text = `Summarize the conversation below so the coding agent can continue the task without the original messages.

Write the summary as a compact briefing. Include:
- The user's goals, and any constraints or preferences they stated
- What has been done so far: concrete file paths, commands, and their results
- Key findings and decisions, with the reasons behind them
- Errors encountered and how they were resolved
- What remains to be done, in order

Be precise. Prefer exact identifiers (paths, symbols, commands) over prose. Do not include commentary about the summary itself.

${previous}<conversation>
${conversation}
</conversation>`

  return Prompt.fromMessages([
    Prompt.makeMessage("system", { content: summarizerSystem }),
    Prompt.makeMessage("user", {
      content: [Prompt.makePart("text", { text })],
    }),
  ])
}

/**
 * Wrap a summary in the `<compaction-summary>` tags used for the synthetic
 * user message.
 *
 * @since 1.0.0
 * @category Rewrite
 */
export const wrapSummary = (summary: string): string =>
  `${summaryOpenTag}\n${summary}\n${summaryCloseTag}`

/**
 * Assemble the compacted Prompt: `[system?, user(wrapSummary(summary)),
 * ...kept]`. The system message is passed through untouched.
 *
 * @since 1.0.0
 * @category Rewrite
 */
export const rewrite = (options: {
  readonly system: Option.Option<Prompt.SystemMessage>
  readonly summary: string
  readonly kept: ReadonlyArray<Prompt.Message>
}): Prompt.Prompt =>
  Prompt.fromMessages([
    ...Option.toArray(options.system),
    Prompt.makeMessage("user", {
      content: [
        Prompt.makePart("text", { text: wrapSummary(options.summary) }),
      ],
    }),
    ...options.kept,
  ])

// =============================================================================
// Compaction
// =============================================================================

/**
 * @since 1.0.0
 * @category Compaction
 */
export type CompactionReason = "threshold" | "overflow"

/**
 * @since 1.0.0
 * @category Compaction
 */
export interface CompactionResult {
  readonly reason: CompactionReason
  readonly prompt: Prompt.Prompt
  /**
   * `estimateTokens` of the prompt before and after the rewrite.
   */
  readonly tokensBefore: number
  readonly tokensAfter: number
}

/**
 * Hooks shared by the compaction entry points.
 *
 * - `onStart` runs once a cut point was found and before the summarizer is
 *   called. It is not invoked for no-op compactions.
 * - `withSummarizer` wraps the summarizer model call so providers can apply
 *   request overrides (e.g. `max_output_tokens`, out-of-band instructions).
 *
 * @since 1.0.0
 * @category Compaction
 */
export interface CompactionHooks {
  readonly onStart?:
    ((reason: CompactionReason) => Effect.Effect<void>) | undefined
  readonly withSummarizer?:
    | (<A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>)
    | undefined
}

/**
 * Run one compaction of `prompt` regardless of thresholds.
 *
 * Steps: `split` (None → returns None, prompt untouched), `summarizerPrompt`,
 * a direct `LanguageModel.streamText` call with no tools, then `rewrite` with
 * `trimKept(kept)`. Provider hooks apply output-token limits where supported.
 * Streaming is required by the Codex backend and selects the websocket
 * transport when available; generateText uses a non-streaming HTTP request.
 *
 * Fails with the summarizer's `AiError`. Callers decide whether that is fatal.
 *
 * @since 1.0.0
 * @category Compaction
 */
export const compact: (
  options: CompactionHooks & {
    readonly prompt: Prompt.Prompt
    readonly reason: CompactionReason
  },
) => Effect.Effect<
  Option.Option<CompactionResult>,
  AiError.AiError,
  LanguageModel.LanguageModel
> = Effect.fnUntraced(function* (options) {
  const config = yield* CompactionConfig
  const parts = split(options.prompt, config.keepRecentTokens)
  if (Option.isNone(parts)) return Option.none()
  const { system, previousSummary, toSummarize, kept } = parts.value

  if (options.onStart) {
    yield* options.onStart(options.reason)
  }

  const ai = yield* LanguageModel.LanguageModel
  const summarize = ai
    .streamText({
      prompt: summarizerPrompt({ previousSummary, messages: toSummarize }),
    })
    .pipe(
      Stream.runFold(
        () => "",
        (text, part) => (part.type === "text-delta" ? text + part.delta : text),
      ),
    )
  const summary = (yield* options.withSummarizer
    ? options.withSummarizer(summarize)
    : summarize).trim()

  if (summary.length === 0) {
    return yield* AiError.make({
      module: "clanka/Compaction",
      method: "compact",
      reason: new AiError.InvalidOutputError({
        description: "The summarizer returned no text",
      }),
    })
  }

  const rewritten = rewrite({
    system,
    summary,
    kept: trimKept(kept, config.keepRecentTokens),
  })
  return Option.some({
    reason: options.reason,
    prompt: rewritten,
    tokensBefore: estimateTokens(options.prompt),
    tokensAfter: estimateTokens(rewritten),
  })
})

/**
 * Compact before the next model call when `shouldCompact` fires.
 *
 * Returns `None` when compaction is disabled, not needed, or a no-op. A
 * failing summarizer is swallowed here: the caller proceeds with the
 * uncompacted prompt and relies on the overflow path.
 *
 * @since 1.0.0
 * @category Compaction
 */
export const compactIfNeeded: (
  options: CompactionHooks & {
    readonly prompt: Prompt.Prompt
    readonly contextTokens: number | undefined
  },
) => Effect.Effect<
  Option.Option<CompactionResult>,
  never,
  LanguageModel.LanguageModel
> = Effect.fnUntraced(function* (options) {
  const config = yield* CompactionConfig
  if (
    !shouldCompact({
      prompt: options.prompt,
      contextTokens: options.contextTokens,
      config,
    })
  ) {
    return Option.none()
  }
  return yield* compact({ ...options, reason: "threshold" }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        "Compaction failed, continuing with the uncompacted prompt",
        error,
      ).pipe(Effect.as(Option.none<CompactionResult>())),
    ),
  )
})

/**
 * Compact after a context-length overflow error.
 *
 * Returns `None` when compaction is disabled or a no-op, in which case the
 * caller fails the turn with the original error. A failing summarizer fails
 * the turn.
 *
 * @since 1.0.0
 * @category Compaction
 */
export const compactAfterOverflow: (
  options: CompactionHooks & {
    readonly prompt: Prompt.Prompt
  },
) => Effect.Effect<
  Option.Option<CompactionResult>,
  AiError.AiError,
  LanguageModel.LanguageModel
> = Effect.fnUntraced(function* (options) {
  const config = yield* CompactionConfig
  if (!config.enabled) return Option.none()
  return yield* compact({ ...options, reason: "overflow" })
})

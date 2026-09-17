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
 * See `.specs/compaction.md` for the full design and implementation notes.
 *
 * @since 1.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
import type * as AiError from "effect/unstable/ai/AiError"
import type * as LanguageModel from "effect/unstable/ai/LanguageModel"
import type * as Prompt from "effect/unstable/ai/Prompt"

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
  contextWindow: 128_000,
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
 * Maximum output tokens requested from the summarizer model call.
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
): CapResult => notImplemented("capOutput", output, maxChars)

// =============================================================================
// Token accounting
// =============================================================================

/**
 * Cheap token estimate for a Prompt: encoded JSON length / 4. Used when no
 * `contextTokens` usage has been observed yet (first turn, ACP session load)
 * and for sizing the kept tail.
 *
 * @since 1.0.0
 * @category Tokens
 */
export const estimateTokens = (prompt: Prompt.Prompt): number =>
  notImplemented("estimateTokens", prompt)

/**
 * Token estimate for a single message. Same measure as `estimateTokens`.
 *
 * @since 1.0.0
 * @category Tokens
 */
export const estimateMessageTokens = (message: Prompt.Message): number =>
  notImplemented("estimateMessageTokens", message)

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
}): boolean => notImplemented("shouldCompact", options)

// =============================================================================
// Overflow detection
// =============================================================================

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
export const isContextLengthError = (error: AiError.AiError): boolean =>
  notImplemented("isContextLengthError", error)

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
): Option.Option<Split> => notImplemented("split", prompt, keepRecentTokens)

/**
 * Find the text of a previous compaction summary in a Prompt, if present.
 *
 * @since 1.0.0
 * @category Cut points
 */
export const findPreviousSummary = (
  prompt: Prompt.Prompt,
): Option.Option<string> => notImplemented("findPreviousSummary", prompt)

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
): ReadonlyArray<Prompt.Message> =>
  notImplemented("trimKept", kept, keepRecentTokens)

// =============================================================================
// Prompt rewrite
// =============================================================================

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
}): Prompt.Prompt => notImplemented("summarizerPrompt", options)

/**
 * Wrap a summary in the `<compaction-summary>` tags used for the synthetic
 * user message.
 *
 * @since 1.0.0
 * @category Rewrite
 */
export const wrapSummary = (summary: string): string =>
  notImplemented("wrapSummary", summary)

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
}): Prompt.Prompt => notImplemented("rewrite", options)

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
 * Run one compaction of `prompt` regardless of thresholds.
 *
 * Steps: `split` (None → returns None, prompt untouched), `summarizerPrompt`,
 * a direct `LanguageModel.streamText` call with no tools and
 * `summarizerMaxOutputTokens`, then `rewrite` with `trimKept(kept)`.
 *
 * Fails with the summarizer's `AiError`. Callers decide whether that is fatal.
 *
 * @since 1.0.0
 * @category Compaction
 */
export const compact = (options: {
  readonly prompt: Prompt.Prompt
  readonly reason: CompactionReason
}): Effect.Effect<
  Option.Option<CompactionResult>,
  AiError.AiError,
  LanguageModel.LanguageModel
> => Effect.sync(() => notImplemented("compact", options))

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
export const compactIfNeeded = (options: {
  readonly prompt: Prompt.Prompt
  readonly contextTokens: number | undefined
}): Effect.Effect<
  Option.Option<CompactionResult>,
  never,
  LanguageModel.LanguageModel
> => Effect.sync(() => notImplemented("compactIfNeeded", options))

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
export const compactAfterOverflow = (options: {
  readonly prompt: Prompt.Prompt
}): Effect.Effect<
  Option.Option<CompactionResult>,
  AiError.AiError,
  LanguageModel.LanguageModel
> => Effect.sync(() => notImplemented("compactAfterOverflow", options))

// oxlint-disable-next-line typescript/no-unused-vars
const notImplemented = (
  name: string,
  ..._args: ReadonlyArray<unknown>
): never => {
  throw new Error(`Compaction.${name} is not implemented`)
}

/**
 * Context compaction for the shared Agent loop.
 *
 * Two independent mechanisms live here:
 *
 * 1. An always-on cap on `execute` results before they enter the Prompt
 *    (`capOutput`). It runs on every surface and is not affected by the
 *    compaction kill switch.
 * 2. Auto-compaction of the live Prompt (`compact` at the threshold, next
 *    to the model calls, and after a context-length error). Both rewrite the
 *    Prompt to `system + <compaction-summary> user message + kept tail`.
 *
 * @since 1.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Stream from "effect/Stream"
import * as AiError from "effect/ai/AiError"
import * as LanguageModel from "effect/ai/LanguageModel"
import type * as Model from "effect/ai/Model"
import * as Prompt from "effect/ai/Prompt"
import type * as AgentOutput from "./AgentOutput.ts"
import * as Image from "./Image.ts"

// =============================================================================
// Configuration
// =============================================================================

/**
 * Runtime configuration for auto-compaction.
 *
 * - `enabled`: kill switch for both compact paths. Does **not** disable the
 *   `execute` output cap.
 * - `contextWindow`: assumed model context window in tokens.
 * - `reserveTokens`: headroom kept free below `contextWindow`.
 * - `thresholdTokens`: compaction triggers once the last reported
 *   `contextTokens` (or the estimate) exceeds this many tokens, or
 *   `contextWindow - reserveTokens` when that is lower. Compacting well below
 *   the context window keeps every turn's input smaller.
 * - `keepRecentTokens`: size of the recent tail preserved verbatim after a
 *   compaction.
 * - `summarizeChunkTokens`: the most a threshold compaction sends to the
 *   summarizer, measured on the rendered summarizer input. Older messages
 *   are summarized first; the rest stay verbatim for a later compaction, so
 *   a long history shrinks over several smaller summaries. Unset uses the
 *   default.
 *
 * @since 1.0.0
 * @category Configuration
 */
export interface CompactionConfigService {
  readonly enabled: boolean
  readonly contextWindow: number
  readonly reserveTokens: number
  readonly thresholdTokens: number
  readonly keepRecentTokens: number
  readonly summarizeChunkTokens?: number | undefined
}

const defaultSummarizeChunkTokens = 64_000

/**
 * @since 1.0.0
 * @category Configuration
 */
export const defaultConfig: CompactionConfigService = {
  enabled: true,
  contextWindow: 236_000,
  reserveTokens: 16_000,
  thresholdTokens: 200_000,
  keepRecentTokens: 20_000,
  summarizeChunkTokens: defaultSummarizeChunkTokens,
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

/**
 * Wraps the summarizer model call so a provider can apply request overrides
 * (e.g. Copilot's `max_output_tokens`). Defaults to the identity.
 *
 * @since 1.0.0
 * @category Configuration
 */
export class SummarizerTransform extends Context.Reference<
  <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
>("clanka/Compaction/SummarizerTransform", {
  defaultValue: () => identity,
}) {}

/**
 * The model the summarizer runs on. Without it, the summarizer runs on the
 * agent's own model.
 *
 * The layer is built for each summarizer call, so a stateful model such as
 * Claude Agent never shares its session with an agent. It replaces the
 * agent's `SummarizerTransform` with its own, or with the identity when it
 * has none.
 *
 * @since 1.0.0
 * @category Configuration
 */
export class SummarizerModel extends Context.Service<
  SummarizerModel,
  Layer.Layer<
    LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName
  >
>()("clanka/Compaction/SummarizerModel") {}

/**
 * Run the summarizer on `layer` instead of the agent's model.
 *
 * @since 1.0.0
 * @category Configuration
 */
export const layerSummarizerModel = <E, R>(
  layer: Layer.Layer<
    LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName,
    E,
    R
  >,
): Layer.Layer<SummarizerModel, never, R> =>
  Layer.effect(
    SummarizerModel,
    Effect.gen(function* () {
      const services = yield* Effect.context<R>()
      return Layer.fresh(Layer.orDie(layer)).pipe(
        Layer.provide(Layer.succeedContext(services)),
      )
    }),
  )

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

/** Cap applied to `execute` results rendered into the summarizer input. */
const summarizerToolResultCapChars = 2_000

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

// Provider image costs vary with dimensions and detail settings. Use a fixed
// fallback until real usage arrives, never the encoded payload size.
const imageTokenEstimate = 1_500

const estimateMessageChars = (message: Prompt.Message): number => {
  if (message.role !== "user" && message.role !== "assistant") {
    return JSON.stringify(message).length
  }
  let imageTokens = 0
  const content = message.content.map((part) => {
    if (part.type !== "file" || !part.mediaType.startsWith("image/")) {
      return part
    }
    imageTokens += imageTokenEstimate
    // Replace the part before stringifying so binary data, base64 and URLs
    // are all opaque, and the original prompt stays untouched.
    return { type: part.type, mediaType: part.mediaType }
  })
  return JSON.stringify({ ...message, content }).length + imageTokens * 4
}

/**
 * Cheap token estimate: JSON length / 4, with a fixed cost per image instead
 * of serializing image payloads. Used when no
 * `contextTokens` usage has been observed yet (first turn, ACP session load)
 * and for sizing the kept tail.
 *
 * @since 1.0.0
 * @category Tokens
 */
export const estimateTokens = (prompt: Prompt.Prompt): number => {
  // Include the array brackets and commas, rounding only once as before.
  let chars = 2 + Math.max(0, prompt.content.length - 1)
  for (const message of prompt.content) {
    chars += estimateMessageChars(message)
  }
  return Math.ceil(chars / 4)
}

/**
 * Token estimate for a single message. Same measure as `estimateTokens`.
 *
 * @since 1.0.0
 * @category Tokens
 */
export const estimateMessageTokens = (message: Prompt.Message): number =>
  Math.ceil(estimateMessageChars(message) / 4)

/**
 * The token count above which the threshold trigger fires: `thresholdTokens`,
 * or `contextWindow - reserveTokens` when that is lower.
 *
 * @since 1.0.0
 * @category Tokens
 */
export const compactionThreshold = (config: CompactionConfigService): number =>
  Math.min(config.thresholdTokens, config.contextWindow - config.reserveTokens)

/**
 * The most a threshold compaction summarizes: `summarizeChunkTokens`, or the
 * default when unset.
 *
 * @since 1.0.0
 * @category Tokens
 */
export const summarizeChunkTokens = (config: CompactionConfigService): number =>
  config.summarizeChunkTokens ?? defaultSummarizeChunkTokens

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
  return tokens > compactionThreshold(options.config)
}

// =============================================================================
// Overflow detection
// =============================================================================

const contextLengthPattern =
  /context[_ ]?(length|window)|too many tokens|prompt is too long|prompt token count|exceeds the (context|token|input )?limit|input token limit|exceeds the model'?s? (context|token|input)/i

const contextLengthCode = "context_length_exceeded"

/**
 * Provider error code from `reason.metadata`, either at the top level or
 * under a provider key (`metadata.openai.errorCode`).
 */
const errorCode = (metadata: unknown): string | undefined => {
  if (!Predicate.isObject(metadata)) return undefined
  if (Predicate.isString(metadata.errorCode)) return metadata.errorCode
  for (const value of Object.values(metadata)) {
    if (Predicate.isObject(value) && Predicate.isString(value.errorCode)) {
      return value.errorCode
    }
  }
  return undefined
}

/**
 * Whether an `AiError` is a context-length overflow from a known provider
 * (Codex / Copilot), as opposed to any other request or transport failure.
 *
 * Any request, unknown or provider error counts when it carries a 413 status,
 * a `context_length_exceeded` code, or a context-length description. These
 * errors are never retried as-is; the Agent compacts first.
 *
 * @since 1.0.0
 * @category Overflow
 */
export const isContextLengthError = (error: AiError.AiError): boolean => {
  const reason = error.reason
  switch (reason._tag) {
    case "InvalidRequestError":
    case "UnknownError":
    case "InternalProviderError":
      return (
        reason.http?.response?.status === 413 ||
        errorCode(reason.metadata) === contextLengthCode ||
        (reason.description !== undefined &&
          contextLengthPattern.test(reason.description))
      )
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
 * Whether a message is the synthetic `<compaction-summary>` user message
 * produced by `rewrite`. Surfaces that replay history (ACP) skip it.
 *
 * @since 1.0.0
 * @category Cut points
 */
export const isSummaryMessage = (message: Prompt.Message): boolean =>
  Option.isSome(summaryText(message))

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
      // Image bytes never reach the summarizer: stub them in place.
      const text = message.content
        .flatMap((part) => {
          switch (part.type) {
            case "text":
              return [part.text]
            case "file":
              return [
                part.mediaType.startsWith("image/")
                  ? Image.omittedText(part.fileName)
                  : `[file: ${part.fileName ?? part.mediaType} omitted]`,
              ]
            default:
              return []
          }
        })
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

  return Prompt.make(text).pipe(Prompt.setSystem(summarizerSystem))
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
// Plan
// =============================================================================

const renderedTokens = (message: Prompt.Message): number =>
  Math.ceil(renderMessage(message).length / 4)

/**
 * What one compaction summarizes and what it keeps.
 *
 * - `toSummarize`: the oldest messages, sent to the summarizer.
 * - `unsummarized`: messages older than the kept tail that did not fit in
 *   `maxSummarizeTokens`. They follow the summary verbatim, for a later
 *   compaction.
 * - `kept`: the recent tail, as in `Split`.
 *
 * @since 1.0.0
 * @category Plan
 */
export interface Plan {
  readonly system: Option.Option<Prompt.SystemMessage>
  readonly previousSummary: Option.Option<string>
  readonly toSummarize: ReadonlyArray<Prompt.Message>
  readonly unsummarized: ReadonlyArray<Prompt.Message>
  readonly kept: ReadonlyArray<Prompt.Message>
}

/**
 * Plan a compaction: `split` the prompt, then limit what is summarized to
 * `maxSummarizeTokens` of rendered summarizer input, oldest first. At least
 * one message is summarized, and a tool result is never separated from its
 * call. Without `maxSummarizeTokens`, everything before the kept tail is
 * summarized.
 *
 * Returns `None` when `split` finds nothing to summarize.
 *
 * @since 1.0.0
 * @category Plan
 */
export const plan = (
  prompt: Prompt.Prompt,
  options: {
    readonly keepRecentTokens: number
    readonly maxSummarizeTokens?: number | undefined
  },
): Option.Option<Plan> =>
  Option.map(split(prompt, options.keepRecentTokens), (parts) => {
    const messages = parts.toSummarize
    const max = options.maxSummarizeTokens ?? Infinity
    let end = 0
    let tokens = 0
    while (end < messages.length) {
      const messageTokens = renderedTokens(messages[end]!)
      if (end > 0 && tokens + messageTokens > max) break
      tokens += messageTokens
      end++
    }
    // A summarized call takes its results with it.
    while (end < messages.length && messages[end]!.role === "tool") {
      end++
    }
    return {
      system: parts.system,
      previousSummary: parts.previousSummary,
      toSummarize: messages.slice(0, end),
      unsummarized: messages.slice(end),
      kept: parts.kept,
    }
  })

/**
 * Whether two plans send the same input to the summarizer.
 *
 * @since 1.0.0
 * @category Plan
 */
export const sameSummarizerInput = (self: Plan, that: Plan): boolean =>
  Option.getOrUndefined(self.previousSummary) ===
    Option.getOrUndefined(that.previousSummary) &&
  self.toSummarize.length === that.toSummarize.length &&
  self.toSummarize.every((message, i) => message === that.toSummarize[i])

// =============================================================================
// Compaction
// =============================================================================

/**
 * @since 1.0.0
 * @category Compaction
 */
export type CompactionReason = typeof AgentOutput.CompactionReason.Type

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
 * Run one compaction of `prompt`.
 *
 * Returns `None` without calling the model when compaction is disabled or
 * when `plan` finds nothing to summarize. Otherwise `onStart` runs, the
 * summarizer is called with `streamText` (the Codex backend rejects
 * non-streaming requests) through `SummarizerTransform`, on the
 * `SummarizerModel` when one is provided, and the prompt is
 * rewritten to `system + summary + unsummarized + trimKept(kept)`.
 *
 * `maxSummarizeTokens` limits the summarizer input, see `plan`. Without it,
 * everything before the kept tail is summarized.
 *
 * Fails with the summarizer's `AiError`. Callers decide whether that is fatal.
 *
 * @since 1.0.0
 * @category Compaction
 */
export const compact: (options: {
  readonly prompt: Prompt.Prompt
  readonly reason: CompactionReason
  /**
   * Runs once a cut point was found, before the summarizer call. Not invoked
   * for no-op compactions.
   */
  readonly onStart?:
    ((reason: CompactionReason) => Effect.Effect<void>) | undefined
  readonly maxSummarizeTokens?: number | undefined
  /**
   * Runs for every part the summarizer streams, so a caller can tell a slow
   * summary from a stalled one.
   */
  readonly onActivity?: (() => void) | undefined
}) => Effect.Effect<
  Option.Option<CompactionResult>,
  AiError.AiError,
  LanguageModel.LanguageModel
> = Effect.fnUntraced(function* (options) {
  const config = yield* CompactionConfig
  if (!config.enabled) return Option.none()
  const parts = plan(options.prompt, {
    keepRecentTokens: config.keepRecentTokens,
    maxSummarizeTokens: options.maxSummarizeTokens,
  })
  if (Option.isNone(parts)) return Option.none()
  const { system, previousSummary, toSummarize, unsummarized, kept } =
    parts.value
  const onActivity = options.onActivity

  if (options.onStart) {
    yield* options.onStart(options.reason)
  }

  const summarize = Effect.gen(function* () {
    const ai = yield* LanguageModel.LanguageModel
    const transform = yield* SummarizerTransform
    return yield* transform(
      ai
        .streamText({
          prompt: summarizerPrompt({ previousSummary, messages: toSummarize }),
        })
        .pipe(
          Stream.runFold(
            () => "",
            (text, part) => {
              onActivity?.()
              return part.type === "text-delta" ? text + part.delta : text
            },
          ),
        ),
    )
  })
  const summarizerModel = yield* Effect.serviceOption(SummarizerModel)
  const summary = (yield* Option.match(summarizerModel, {
    onNone: () => summarize,
    onSome: (model) =>
      summarize.pipe(
        Effect.provide(model),
        Effect.provideService(SummarizerTransform, identity),
      ),
  })).trim()

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
    kept: [...unsummarized, ...trimKept(kept, config.keepRecentTokens)],
  })
  return Option.some({
    reason: options.reason,
    prompt: rewritten,
    tokensBefore: estimateTokens(options.prompt),
    tokensAfter: estimateTokens(rewritten),
  })
})

/**
 * Compact before the next model call when `shouldCompact` fires, summarizing
 * at most `summarizeChunkTokens`.
 *
 * Returns `None` when compaction is disabled, not needed, or a no-op. A
 * failing summarizer is swallowed here: the caller proceeds with the
 * uncompacted prompt and relies on the overflow path.
 *
 * @since 1.0.0
 * @category Compaction
 */
export const compactIfNeeded: (options: {
  readonly prompt: Prompt.Prompt
  readonly contextTokens: number | undefined
  readonly onStart?:
    ((reason: CompactionReason) => Effect.Effect<void>) | undefined
}) => Effect.Effect<
  Option.Option<CompactionResult>,
  never,
  LanguageModel.LanguageModel
> = Effect.fnUntraced(function* (options) {
  const config = yield* CompactionConfig
  if (!shouldCompact({ ...options, config })) return Option.none()
  return yield* compact({
    ...options,
    reason: "threshold",
    maxSummarizeTokens: summarizeChunkTokens(config),
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        "Compaction failed, continuing with the uncompacted prompt",
        error,
      ).pipe(Effect.as(Option.none<CompactionResult>())),
    ),
  )
})

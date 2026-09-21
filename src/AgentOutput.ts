/**
 * @since 1.0.0
 */
/** @effect-diagnostics schemaNumber:off */
import * as Prompt from "effect/unstable/ai/Prompt"
import * as AiError from "effect/unstable/ai/AiError"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

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
  contextTokens: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  /**
   * Cumulative provider-reported cache reads. This is a provider-specific
   * breakdown of input usage, not additional input to add to `inputTokens`.
   * Zero means no cache reads were reported, not that none occurred.
   */
  cacheRead: Schema.Number.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0)),
    Schema.withConstructorDefault(Effect.succeed(0)),
  ),
  /**
   * Cumulative provider-reported cache writes. This is a provider-specific
   * breakdown of input usage, not additional input to add to `inputTokens`.
   * Zero means no cache writes were reported, not that none occurred.
   */
  cacheWrite: Schema.Number.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0)),
    Schema.withConstructorDefault(Effect.succeed(0)),
  ),
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

/**
 * Emitted when an `execute` result exceeded the always-on output cap and was
 * shortened before being appended to the Prompt.
 *
 * @since 1.0.0
 * @category Output
 */
export class ExecuteOutputCapped extends Schema.TaggedClass<ExecuteOutputCapped>()(
  "ExecuteOutputCapped",
  {
    charsBefore: Schema.Number,
    charsAfter: Schema.Number,
  },
) {}

/**
 * @since 1.0.0
 * @category Output
 */
export const CompactionReason = Schema.Literals(["threshold", "overflow"])

/**
 * Emitted when auto-compaction begins. `reason` is `threshold` when the
 * context token count crossed the configured limit before a model call, and
 * `overflow` when a context-length error from the provider triggered it.
 *
 * @since 1.0.0
 * @category Output
 */
export class CompactionStarted extends Schema.TaggedClass<CompactionStarted>()(
  "CompactionStarted",
  {
    reason: CompactionReason,
  },
) {}

/**
 * Emitted when auto-compaction finished and the Prompt was rewritten.
 * `tokensBefore` / `tokensAfter` are estimates.
 *
 * @since 1.0.0
 * @category Output
 */
export class CompactionEnded extends Schema.TaggedClass<CompactionEnded>()(
  "CompactionEnded",
  {
    reason: CompactionReason,
    tokensBefore: Schema.Number,
    tokensAfter: Schema.Number,
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
  | ExecuteOutputCapped
  | CompactionStarted
  | CompactionEnded

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
  ExecuteOutputCapped,
  CompactionStarted,
  CompactionEnded,
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
  AgentStart | ContentPart | SubagentStart | SubagentComplete | SubagentPart

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
export class AgentFinished extends Schema.TaggedError<AgentFinished>()(
  "AgentFinished",
  {
    summary: Schema.String,
  },
) {}

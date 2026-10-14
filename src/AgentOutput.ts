/**
 * @since 1.0.0
 */
/** @effect-diagnostics schemaNumber:off */
import * as Prompt from "effect/ai/Prompt"
import * as AiError from "effect/ai/AiError"
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
   * Cumulative cache reads included in `inputTokens`. Zero is not proof of no cache activity.
   */
  cacheRead: Schema.Number,
  /**
   * Cumulative cache writes included in `inputTokens`. Zero is not proof of no cache activity.
   */
  cacheWrite: Schema.Number,
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
    /**
     * Background agents report only their start and completion; their
     * output is not streamed.
     */
    background: Schema.Boolean.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(false)),
      Schema.withConstructorDefault(Effect.succeed(false)),
    ),
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
    /**
     * The agent's final output, or the error message when it failed.
     */
    summary: Schema.String,
    status: Schema.Literals(["completed", "failed", "cancelled"]).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed("completed" as const)),
      Schema.withConstructorDefault(Effect.succeed("completed" as const)),
    ),
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

/**
 * Emitted when AGENTS.md files or skills the model has not seen yet are
 * added to the history, after a directory change or a compaction. `update`
 * is the text the model receives.
 *
 * @since 1.0.0
 * @category Output
 */
export class EnvironmentUpdated extends Schema.TaggedClass<EnvironmentUpdated>()(
  "EnvironmentUpdated",
  {
    update: Schema.String,
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
  | EnvironmentUpdated

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
  EnvironmentUpdated,
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
 * Emitted when messages are committed to the agent's history: the user
 * prompt, steering messages, and each model step's response and tool
 * results. Applying `HistoryAppended` and `HistoryReplaced` in order to the
 * history the agent started `send` with reproduces `agent.history`, minus
 * the system message, which is rebuilt on every `send`.
 *
 * Only the top-level agent emits history events. Subagents have no history.
 *
 * @since 1.0.0
 * @category Output
 */
export class HistoryAppended extends Schema.TaggedClass<HistoryAppended>()(
  "HistoryAppended",
  {
    messages: Schema.Array(Prompt.Message),
  },
) {}

/**
 * Emitted when compaction rewrites the agent's history. `messages` is the
 * whole new history, without the system message.
 *
 * @since 1.0.0
 * @category Output
 */
export class HistoryReplaced extends Schema.TaggedClass<HistoryReplaced>()(
  "HistoryReplaced",
  {
    messages: Schema.Array(Prompt.Message),
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
  | HistoryAppended
  | HistoryReplaced

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
  HistoryAppended,
  HistoryReplaced,
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

/**
 * The `send` stream fails with this error when a model call, or a turn that
 * hit `TurnTimeout`, was retried `MaxRetries` times in a row and still failed.
 * `error` is the last failure.
 *
 * @since 1.0.0
 * @category Output
 */
export class RetriesExhausted extends Schema.TaggedError<RetriesExhausted>()(
  "RetriesExhausted",
  {
    retries: Schema.Number,
    error: AiError.AiError,
  },
) {}

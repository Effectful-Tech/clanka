/**
 * @since 1.0.0
 */
import * as Prompt from "effect/unstable/ai/Prompt"
import * as AiError from "effect/unstable/ai/AiError"
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

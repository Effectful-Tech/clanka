/** @effect-diagnostics schemaNumber:off */
/**
 * Agent Client Protocol (ACP) server for clanka.
 *
 * Speaks JSON-RPC 2.0 over stdio so ACP clients (Zed, Multica, ...) can drive
 * an Agent. Sessions are persisted to the KeyValueStore so `session/load`
 * works across processes.
 *
 * @since 1.0.0
 */
import { randomUUID } from "node:crypto"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import type * as Layer from "effect/Layer"
import * as MutableRef from "effect/MutableRef"
import * as Option from "effect/Option"
import type * as PlatformError from "effect/PlatformError"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import type * as LanguageModel from "effect/unstable/ai/LanguageModel"
import type * as Model from "effect/unstable/ai/Model"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import type * as Agent from "./Agent.ts"
import type * as AgentOutput from "./AgentOutput.ts"

/**
 * @since 1.0.0
 * @category Models
 */
export type ModelServices =
  | LanguageModel.LanguageModel
  | Model.ProviderName
  | Model.ModelName
  | Agent.SubagentModel

/**
 * @since 1.0.0
 * @category Models
 */
export interface Options<RAgent, RModel> {
  readonly version: string
  /**
   * Model id used when a client does not select one. Model ids are opaque to
   * the server and resolved with `makeModel`.
   */
  readonly defaultModel: string
  /**
   * Write one JSON-RPC message to the client.
   */
  readonly send: (message: object) => Effect.Effect<void>
  /**
   * Create the Agent backing a session rooted at `cwd`.
   */
  readonly makeAgent: (
    cwd: string,
  ) => Effect.Effect<Agent.Agent, never, Scope.Scope | RAgent>
  /**
   * Resolve a model id to the services an Agent needs. `None` rejects the id.
   */
  readonly makeModel: (
    modelId: string,
  ) => Option.Option<Layer.Layer<ModelServices, never, RModel>>
}

/**
 * @since 1.0.0
 * @category Models
 */
export interface Server<R = never> {
  /**
   * Handle one line of JSON-RPC input. Completes once the message has been
   * fully processed, including any responses sent.
   */
  readonly handle: (line: string) => Effect.Effect<void, never, R>
}

/**
 * @since 1.0.0
 * @category Models
 */
export class SessionRecord extends Schema.Class<SessionRecord>(
  "clanka/Acp/SessionRecord",
)({
  cwd: Schema.String,
  model: Schema.String,
  history: Prompt.Prompt,
}) {}

/**
 * @since 1.0.0
 * @category Errors
 */
export class RpcError extends Schema.TaggedError<RpcError>()("AcpRpcError", {
  code: Schema.Number,
  message: Schema.String,
}) {}

const RequestId = Schema.Union([Schema.Number, Schema.String])

const IncomingMessage = Schema.Struct({
  id: Schema.optionalKey(RequestId),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
})

const decodeIncoming = Schema.decodeEffect(
  Schema.fromJsonString(IncomingMessage),
)

const NewSessionParams = Schema.Struct({
  cwd: Schema.String,
  model: Schema.optionalKey(Schema.String),
})

const LoadSessionParams = Schema.Struct({
  sessionId: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
})

const SessionIdParams = Schema.Struct({
  sessionId: Schema.String,
})

const SetModelParams = Schema.Struct({
  sessionId: Schema.String,
  modelId: Schema.String,
})

const TextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
})

const ResourceLinkBlock = Schema.Struct({
  type: Schema.Literal("resource_link"),
  uri: Schema.String,
  name: Schema.optionalKey(Schema.String),
})

const ResourceBlock = Schema.Struct({
  type: Schema.Literal("resource"),
  resource: Schema.Struct({
    uri: Schema.String,
    text: Schema.optionalKey(Schema.String),
  }),
})

const ContentBlock = Schema.Union([TextBlock, ResourceLinkBlock, ResourceBlock])

const PromptParams = Schema.Struct({
  sessionId: Schema.String,
  prompt: Schema.Array(ContentBlock),
})

const decodeParams = <S extends Schema.Top>(schema: S, params: unknown) =>
  Schema.decodeUnknownEffect(schema)(params).pipe(
    Effect.mapError(
      (error) => new RpcError({ code: -32602, message: error.message }),
    ),
  )

const sessionNotFound = (sessionId: string) =>
  new RpcError({ code: -32602, message: `Session not found: ${sessionId}` })

const toRpcError = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error instanceof RpcError
    ? error
    : new RpcError({ code: -32603, message: Cause.pretty(cause) })
}

const renderPrompt = (
  blocks: ReadonlyArray<typeof ContentBlock.Type>,
): string =>
  blocks
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text
        case "resource_link":
          return `[${block.name ?? block.uri}](${block.uri})`
        case "resource":
          return block.resource.text === undefined
            ? `[${block.resource.uri}](${block.resource.uri})`
            : `<resource uri="${block.resource.uri}">\n${block.resource.text}\n</resource>`
      }
    })
    .join("\n\n")

const textContent = (text: string) => ({ type: "text", text })

const historyUpdates = (history: Prompt.Prompt) => {
  const updates: Array<object> = []
  for (const message of history.content) {
    if (message.role !== "user" && message.role !== "assistant") continue
    const sessionUpdate =
      message.role === "user" ? "user_message_chunk" : "agent_message_chunk"
    for (const part of message.content) {
      if (part.type === "text") {
        updates.push({ sessionUpdate, content: textContent(part.text) })
      }
    }
  }
  return updates
}

interface Session {
  readonly id: string
  readonly cwd: string
  model: string
  readonly agent: Agent.Agent
  running: Fiber.Fiber<void, unknown> | undefined
  toolCalls: number
}

/**
 * @since 1.0.0
 * @category Constructors
 */
export const make = Effect.fnUntraced(function* <RAgent, RModel>(
  options: Options<RAgent, RModel>,
): Effect.fn.Return<
  Server<RAgent | RModel>,
  never,
  KeyValueStore.KeyValueStore | Scope.Scope
> {
  const kvs = yield* KeyValueStore.KeyValueStore
  const store = KeyValueStore.toSchemaStore(
    KeyValueStore.prefix(kvs, "session-"),
    SessionRecord,
  )
  const scope = yield* Effect.scope
  const sessions = new Map<string, Session>()

  const notify = (method: string, params: object) =>
    options.send({ jsonrpc: "2.0", method, params })

  const update = (sessionId: string, update: object) =>
    notify("session/update", { sessionId, update })

  const getSession = (sessionId: string) =>
    Effect.fromOption(Option.fromNullishOr(sessions.get(sessionId)), () =>
      sessionNotFound(sessionId),
    )

  const requireModel = (modelId: string) =>
    Effect.fromOption(
      options.makeModel(modelId),
      () =>
        new RpcError({ code: -32602, message: `Unknown model: ${modelId}` }),
    )

  const modelsInfo = (session: Session) => ({
    availableModels: [...new Set([session.model, options.defaultModel])].map(
      (modelId) => ({ modelId, name: modelId }),
    ),
    currentModelId: session.model,
  })

  const persist = (session: Session) =>
    store
      .set(
        session.id,
        new SessionRecord({
          cwd: session.cwd,
          model: session.model,
          history: session.agent.history.current,
        }),
      )
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Failed to persist session", error),
        ),
      )

  const openSession = Effect.fnUntraced(function* (
    id: string,
    record: SessionRecord,
  ) {
    const agent = yield* Scope.provide(options.makeAgent(record.cwd), scope)
    MutableRef.set(agent.history, record.history)
    const session: Session = {
      id,
      cwd: record.cwd,
      model: record.model,
      agent,
      running: undefined,
      toolCalls: 0,
    }
    sessions.set(id, session)
    return session
  })

  const replayHistory = (session: Session) =>
    Effect.forEach(
      historyUpdates(session.agent.history.current),
      (sessionUpdate) => update(session.id, sessionUpdate),
      { discard: true },
    )

  const runTurn = Effect.fnUntraced(function* (
    session: Session,
    prompt: string,
  ) {
    const stream = yield* session.agent.send({ prompt })
    let script = ""
    let toolCallId = ""

    const emit = (part: AgentOutput.Output): Effect.Effect<void> => {
      switch (part._tag) {
        case "ReasoningDelta":
          return update(session.id, {
            sessionUpdate: "agent_thought_chunk",
            content: textContent(part.delta),
          })
        case "ScriptStart":
          script = ""
          return Effect.void
        case "ScriptDelta":
          script += part.delta
          return Effect.void
        case "ScriptEnd":
          toolCallId = `execute-${++session.toolCalls}`
          return update(session.id, {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "execute",
            kind: "execute",
            status: "in_progress",
            rawInput: { script },
            content: [{ type: "content", content: textContent(script) }],
          })
        case "ScriptOutput":
          return update(session.id, {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: { output: part.output },
            content: [{ type: "content", content: textContent(part.output) }],
          })
        case "Usage":
          return update(session.id, {
            sessionUpdate: "usage_update",
            usage: {
              inputTokens: part.inputTokens,
              outputTokens: part.outputTokens,
            },
          })
        case "ErrorRetry":
          return update(session.id, {
            sessionUpdate: "agent_thought_chunk",
            content: textContent(
              `Retrying after error: ${part.error.message}\n`,
            ),
          })
        case "SubagentStart":
          return update(session.id, {
            sessionUpdate: "tool_call",
            toolCallId: `subagent-${part.id}`,
            title: "subagent",
            kind: "think",
            status: "in_progress",
            rawInput: { prompt: part.prompt },
          })
        case "SubagentComplete":
          return update(session.id, {
            sessionUpdate: "tool_call_update",
            toolCallId: `subagent-${part.id}`,
            status: "completed",
            rawOutput: { summary: part.summary },
            content: [{ type: "content", content: textContent(part.summary) }],
          })
        default:
          return Effect.void
      }
    }

    yield* stream.pipe(
      Stream.runForEach(emit),
      Effect.catchTag("AgentFinished", (finished) =>
        update(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: textContent(finished.summary),
        }),
      ),
    )
  })

  const initialize = Effect.succeed({
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: true },
      mcpCapabilities: { http: false, sse: false },
    },
    authMethods: [],
    agentInfo: { name: "clanka", version: options.version },
  })

  const newSession = Effect.fnUntraced(function* (params: unknown) {
    const { cwd, model } = yield* decodeParams(NewSessionParams, params)
    const modelId = model ?? options.defaultModel
    yield* requireModel(modelId)
    const session = yield* openSession(
      randomUUID(),
      new SessionRecord({ cwd, model: modelId, history: Prompt.empty }),
    )
    yield* persist(session)
    return { sessionId: session.id, models: modelsInfo(session) }
  })

  const loadSession = Effect.fnUntraced(function* (
    params: unknown,
    replay: boolean,
  ) {
    const { sessionId, cwd, model } = yield* decodeParams(
      LoadSessionParams,
      params,
    )
    const existing = sessions.get(sessionId)
    if (existing !== undefined) {
      return { models: modelsInfo(existing) }
    }
    const record = yield* store
      .get(sessionId)
      .pipe(
        Effect.mapError(
          (error) => new RpcError({ code: -32603, message: error.message }),
        ),
      )
    if (Option.isNone(record)) {
      return yield* sessionNotFound(sessionId)
    }
    const modelId = model ?? record.value.model
    yield* requireModel(modelId)
    const session = yield* openSession(
      sessionId,
      new SessionRecord({
        cwd: cwd ?? record.value.cwd,
        model: modelId,
        history: record.value.history,
      }),
    )
    if (replay) {
      yield* replayHistory(session)
    }
    return { models: modelsInfo(session) }
  })

  const setModel = Effect.fnUntraced(function* (params: unknown) {
    const { sessionId, modelId } = yield* decodeParams(SetModelParams, params)
    const session = yield* getSession(sessionId)
    yield* requireModel(modelId)
    session.model = modelId
    yield* persist(session)
    return {}
  })

  const prompt = Effect.fnUntraced(function* (params: unknown) {
    const { sessionId, prompt } = yield* decodeParams(PromptParams, params)
    const session = yield* getSession(sessionId)
    if (session.running !== undefined) {
      return yield* new RpcError({
        code: -32000,
        message: `Session ${sessionId} already has a prompt in progress`,
      })
    }
    const model = yield* requireModel(session.model)
    session.running = yield* runTurn(session, renderPrompt(prompt)).pipe(
      Effect.provide(model),
      Effect.scoped,
      Effect.forkChild,
    )
    const exit = yield* Effect.exit(Fiber.join(session.running))
    session.running = undefined
    yield* persist(session)
    if (Exit.isSuccess(exit)) return { stopReason: "end_turn" }
    if (Cause.hasInterruptsOnly(exit.cause)) return { stopReason: "cancelled" }
    return yield* toRpcError(exit.cause)
  })

  const cancel = Effect.fnUntraced(function* (params: unknown) {
    const { sessionId } = yield* decodeParams(SessionIdParams, params)
    const running = sessions.get(sessionId)?.running
    if (running !== undefined) {
      yield* Fiber.interrupt(running)
    }
  })

  const dispatch = (
    method: string,
    params: unknown,
  ): Effect.Effect<object, RpcError, RAgent | RModel> => {
    switch (method) {
      case "initialize":
        return initialize
      case "authenticate":
      case "session/set_mode":
      case "session/set_config_option":
        return Effect.succeed({})
      case "session/new":
        return newSession(params)
      case "session/load":
        return loadSession(params, true)
      case "session/resume":
        return loadSession(params, false)
      case "session/set_model":
        return setModel(params)
      case "session/prompt":
        return prompt(params)
      default:
        return Effect.fail(
          new RpcError({
            code: -32601,
            message: `Method not found: ${method}`,
          }),
        )
    }
  }

  const handle = Effect.fnUntraced(
    function* (line: string) {
      if (line.trim() === "") return
      const message = yield* decodeIncoming(line)
      // Responses to requests are ignored: the server never sends requests
      if (message.method === undefined) return
      if (message.id === undefined) {
        if (message.method === "session/cancel") {
          yield* cancel(message.params)
        }
        return
      }
      const id = message.id
      yield* dispatch(message.method, message.params).pipe(
        Effect.matchCauseEffect({
          onSuccess: (result) => options.send({ jsonrpc: "2.0", id, result }),
          onFailure: (cause) => {
            const error = toRpcError(cause)
            return options.send({
              jsonrpc: "2.0",
              id,
              error: { code: error.code, message: error.message },
            })
          },
        }),
      )
    },
    Effect.catch((error) =>
      Effect.logWarning("Ignoring invalid JSON-RPC message", error),
    ),
  )

  return { handle }
})

/**
 * Run the ACP server over the process stdio.
 *
 * @since 1.0.0
 * @category Constructors
 */
export const runStdio = <RAgent, RModel>(
  options: Omit<Options<RAgent, RModel>, "send">,
): Effect.Effect<
  void,
  PlatformError.PlatformError,
  Stdio.Stdio | KeyValueStore.KeyValueStore | RAgent | RModel
> =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    const output = yield* Queue.make<string, Cause.Done>()
    const writer = yield* Stream.fromQueue(output).pipe(
      Stream.map((line) => `${line}\n`),
      Stream.run(stdio.stdout()),
      Effect.forkScoped,
    )
    const server = yield* make({
      ...options,
      send: (message) =>
        Queue.offer(output, JSON.stringify(message)).pipe(Effect.asVoid),
    })
    yield* stdio.stdin.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => Effect.forkScoped(server.handle(line))),
    )
    yield* Queue.end(output)
    yield* Fiber.join(writer)
  }).pipe(Effect.scoped)

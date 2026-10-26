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
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as MutableRef from "effect/MutableRef"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import * as Queue from "effect/Queue"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import type * as LanguageModel from "effect/ai/LanguageModel"
import type * as Model from "effect/ai/Model"
import * as Prompt from "effect/ai/Prompt"
import * as HttpClient from "effect/http/HttpClient"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Agent from "./Agent.ts"
import * as AgentExecutor from "./AgentExecutor.ts"
import type * as AgentOutput from "./AgentOutput.ts"
import * as Compaction from "./Compaction.ts"
import * as Image from "./Image.ts"
import * as McpServers from "./McpServers.ts"

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
   * Thought level used for new sessions.
   */
  readonly defaultThoughtLevel: ThoughtLevel
  /**
   * Whether new sessions start in fast mode. Defaults to `false`.
   */
  readonly defaultFastMode?: boolean | undefined
  /**
   * Whether a model id supports fast mode. The `fast_mode` config option is
   * offered only while the session model does. Defaults to no model.
   */
  readonly supportsFastMode?: ((modelId: string) => boolean) | undefined
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
   * Resolve a model id, thought level and fast mode to the services an Agent
   * needs. `fastMode` is only `true` for models `supportsFastMode` accepts.
   * `None` rejects the combination.
   */
  readonly makeModel: (
    modelId: string,
    thoughtLevel: ThoughtLevel,
    fastMode: boolean,
  ) => Option.Option<Layer.Layer<ModelServices, never, RModel>>
  /**
   * Models to advertise as `availableModels`, listed first in this order. The
   * session model and `defaultModel` are appended when missing. Ids stay
   * opaque: `makeModel` alone decides what runs. Defaults to only those two.
   */
  readonly availableModels?:
    | Effect.Effect<
        ReadonlyArray<{ readonly modelId: string; readonly name: string }>
      >
    | undefined
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
 * Reasoning effort levels offered through the ACP `thought_level` config
 * option.
 *
 * @since 1.0.0
 * @category Models
 */
export const ThoughtLevel = Schema.Literals([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

/**
 * @since 1.0.0
 * @category Models
 */
export type ThoughtLevel = typeof ThoughtLevel.Type

/**
 * @since 1.0.0
 * @category Models
 */
export class SessionRecord extends Schema.Class<SessionRecord>(
  "clanka/Acp/SessionRecord",
)({
  cwd: Schema.String,
  model: Schema.String,
  thoughtLevel: ThoughtLevel,
  /**
   * The session's fast mode setting. It is kept across model switches and
   * applies while the session model supports fast mode.
   */
  fastMode: Schema.optionalKey(Schema.Boolean),
  history: Prompt.Prompt,
  /**
   * The agent's executor environment, such as its working directory.
   */
  environment: Schema.optionalKey(AgentExecutor.ExecutionEnvironment),
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

const NameValue = Schema.Struct({ name: Schema.String, value: Schema.String })

// stdio entries carry no `type`.
const McpServer = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("http"),
    name: Schema.String,
    url: Schema.String,
    headers: Schema.optionalKey(Schema.Array(NameValue)),
  }),
  Schema.Struct({
    type: Schema.Literal("sse"),
    name: Schema.String,
  }),
  Schema.Struct({
    type: Schema.optionalKey(Schema.Literal("stdio")),
    name: Schema.String,
    command: Schema.String,
    args: Schema.optionalKey(Schema.Array(Schema.String)),
    env: Schema.optionalKey(Schema.Array(NameValue)),
  }),
])

const NewSessionParams = Schema.Struct({
  cwd: Schema.String,
  model: Schema.optionalKey(Schema.String),
  mcpServers: Schema.optionalKey(Schema.Array(McpServer)),
})

const LoadSessionParams = Schema.Struct({
  sessionId: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  mcpServers: Schema.optionalKey(Schema.Array(McpServer)),
})

const redactValues = (
  entries: ReadonlyArray<typeof NameValue.Type> | undefined,
): Record<string, Redacted.Redacted<string>> =>
  Object.fromEntries(
    (entries ?? []).map(({ name, value }) => [name, Redacted.make(value)]),
  )

/**
 * The servers sent with `session/new`, `session/load` or `session/resume`.
 * stdio servers run in the session's cwd; the first of two servers with the
 * same name wins.
 */
const mcpServerEntries = Effect.fnUntraced(function* (
  servers: ReadonlyArray<typeof McpServer.Type>,
  cwd: string,
) {
  const entries: Record<string, McpServers.ServerEntry> = Object.create(null)
  for (const server of servers) {
    if (Object.hasOwn(entries, server.name)) {
      yield* Effect.logWarning("Skipping duplicate MCP server").pipe(
        Effect.annotateLogs({ server: server.name }),
      )
      continue
    }
    switch (server.type) {
      case "http":
        entries[server.name] = {
          type: "http",
          url: server.url,
          headers: redactValues(server.headers),
        }
        break
      case "sse":
        entries[server.name] = {
          type: "unavailable",
          error: "SSE transport is not supported",
        }
        break
      default:
        entries[server.name] = {
          type: "stdio",
          command: server.command,
          args: server.args ?? [],
          env: redactValues(server.env),
          cwd,
        }
    }
  }
  return entries
})

const SessionIdParams = Schema.Struct({
  sessionId: Schema.String,
})

const SetModelParams = Schema.Struct({
  sessionId: Schema.String,
  modelId: Schema.String,
})

// The `fast_mode` select values. A select works with every client; a
// `boolean` option needs the client's `configOptions.boolean` capability.
const FastModeValue = Schema.Literals(["off", "on"])

const SetConfigOptionParams = Schema.Union([
  Schema.Struct({
    sessionId: Schema.String,
    configId: Schema.Literal("thought_level"),
    value: ThoughtLevel,
  }),
  Schema.Struct({
    sessionId: Schema.String,
    configId: Schema.Literal("fast_mode"),
    value: FastModeValue,
  }),
])

const TextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
})

const ImageBlock = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
  uri: Schema.optionalKey(Schema.String),
})

const ResourceLinkBlock = Schema.Struct({
  type: Schema.Literal("resource_link"),
  uri: Schema.String,
  name: Schema.optionalKey(Schema.String),
  mimeType: Schema.optionalKey(Schema.String),
})

const ResourceBlock = Schema.Struct({
  type: Schema.Literal("resource"),
  resource: Schema.Struct({
    uri: Schema.String,
    mimeType: Schema.optionalKey(Schema.String),
    text: Schema.optionalKey(Schema.String),
    blob: Schema.optionalKey(Schema.String),
  }),
})

const ContentBlock = Schema.Union([
  TextBlock,
  ImageBlock,
  ResourceLinkBlock,
  ResourceBlock,
])

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

const renderLink = (uri: string, name?: string) => `[${name ?? uri}](${uri})`

// Covers the request and entire body read.
const remoteImageTimeout = "30 seconds"

const invalidParams = (message: string) =>
  new RpcError({ code: -32602, message })

const decodeBase64 = (data: string, what: string) => {
  if (data.length > Math.ceil(Image.maxInputBytes / 3) * 4) {
    return Effect.fail(
      invalidParams(
        `Image data in ${what} exceeds the ${Image.maxInputBytes} byte input limit`,
      ),
    )
  }
  const decoded = Base64.decode(data)
  return decoded._tag === "Success"
    ? Effect.succeed(decoded.success)
    : Effect.fail(invalidParams(`Invalid base64 image data in ${what}`))
}

const fileNameOf = (uri: string | undefined): string | undefined => {
  if (uri === undefined) return undefined
  return uri.split(/[\\/]/).findLast((part) => part.length > 0)
}

const textContent = (text: string) => ({ type: "text", text })

const imageContent = (part: Prompt.FilePart) =>
  Option.map(Image.partBytes(part), (bytes) => ({
    type: "image",
    data: Base64.encode(bytes),
    mimeType: part.mediaType,
  }))

const historyUpdates = (history: Prompt.Prompt) => {
  const updates: Array<object> = []
  for (const message of history.content) {
    if (message.role !== "user" && message.role !== "assistant") continue
    if (Compaction.isSummaryMessage(message)) continue
    if (Agent.isInjectedMessage(message)) continue
    const sessionUpdate =
      message.role === "user" ? "user_message_chunk" : "agent_message_chunk"
    for (const part of message.content) {
      if (part.type === "text") {
        updates.push({ sessionUpdate, content: textContent(part.text) })
      } else if (message.role === "user" && Image.isImagePart(part)) {
        const content = imageContent(part)
        if (Option.isSome(content)) {
          updates.push({ sessionUpdate, content: content.value })
        }
      }
    }
  }
  return updates
}

interface Session {
  readonly id: string
  readonly cwd: string
  model: string
  thoughtLevel: ThoughtLevel
  fastMode: boolean
  readonly agent: Agent.Agent
  running: Fiber.Fiber<void, unknown> | undefined
  toolCalls: number
  readonly announcedSubagents: Set<number>
  /** Owns the Agent and the session's MCP servers. */
  readonly scope: Scope.Closeable
  /** Failed MCP servers, reported on the first prompt turn. */
  mcpFailures: string | undefined
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
  const { contextWindow } = yield* Compaction.CompactionConfig
  const size = Number.isFinite(contextWindow)
    ? Math.max(0, Math.round(contextWindow))
    : 0
  // Optional: `https:` images need an HttpClient and `file:` images need a
  // FileSystem and Path. Inline (base64) images work without either. When a
  // service is missing the corresponding block is rejected, never fetched.
  const http = yield* Effect.serviceOption(HttpClient.HttpClient)
  const fs = yield* Effect.serviceOption(FileSystem.FileSystem)
  const path = yield* Effect.serviceOption(Path.Path)
  const store = KeyValueStore.toSchemaStore(
    KeyValueStore.prefix(kvs, "session-"),
    SessionRecord,
  )
  const scope = yield* Effect.scope
  const sessions = new Map<string, Session>()

  // Whatever ends the server, name the prompts it leaves unfinished. An
  // interrupted prompt keeps its `running` fiber.
  yield* Effect.addFinalizer(() => {
    const running = Array.from(sessions.values())
      .filter((session) => session.running !== undefined)
      .map((session) => session.id)
    return running.length === 0
      ? Effect.void
      : Effect.logWarning("ACP server stopping with prompts in progress").pipe(
          Effect.annotateLogs({ sessions: running.join(", ") }),
        )
  })

  const notify = (method: string, params: object) =>
    options.send({ jsonrpc: "2.0", method, params })

  const update = (sessionId: string, update: object) =>
    notify("session/update", { sessionId, update })

  const getSession = (sessionId: string) =>
    Effect.fromOption(Option.fromNullishOr(sessions.get(sessionId)), () =>
      sessionNotFound(sessionId),
    )

  const supportsFastMode = (modelId: string) =>
    options.supportsFastMode?.(modelId) ?? false

  const requireModel = (
    modelId: string,
    thoughtLevel: ThoughtLevel,
    fastMode: boolean,
  ) =>
    Effect.fromOption(
      options.makeModel(
        modelId,
        thoughtLevel,
        fastMode && supportsFastMode(modelId),
      ),
      () =>
        new RpcError({ code: -32602, message: `Unknown model: ${modelId}` }),
    )

  const configOptions = (session: Session) => [
    {
      id: "thought_level",
      name: "Thought level",
      category: "thought_level",
      type: "select",
      currentValue: session.thoughtLevel,
      options: ThoughtLevel.literals.map((value) => ({ value, name: value })),
    },
    ...(supportsFastMode(session.model)
      ? [
          {
            id: "fast_mode",
            name: "Fast mode",
            description: "Faster responses at a higher cost",
            category: "model_config",
            type: "select",
            currentValue: session.fastMode ? "on" : "off",
            options: [
              { value: "off", name: "Off" },
              { value: "on", name: "On" },
            ],
          },
        ]
      : []),
  ]

  const sessionState = Effect.fnUntraced(function* (session: Session) {
    const catalog =
      options.availableModels === undefined
        ? []
        : yield* options.availableModels
    const listed = new Set(catalog.map((model) => model.modelId))
    return {
      models: {
        availableModels: [
          ...catalog,
          ...[...new Set([session.model, options.defaultModel])]
            .filter((modelId) => !listed.has(modelId))
            .map((modelId) => ({ modelId, name: modelId })),
        ],
        currentModelId: session.model,
      },
      configOptions: configOptions(session),
    }
  })

  const persist = (session: Session) =>
    store
      .set(
        session.id,
        new SessionRecord({
          cwd: session.cwd,
          model: session.model,
          thoughtLevel: session.thoughtLevel,
          fastMode: session.fastMode,
          history: session.agent.history.current,
          environment: session.agent.environment.current,
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
    mcpServers: ReadonlyArray<typeof McpServer.Type>,
  ) {
    const sessionScope = yield* Scope.fork(scope)
    let makeAgent = options.makeAgent(record.cwd)
    let mcpFailures: string | undefined
    // Never stored: the servers come with every request that opens the
    // session, and their URLs can carry tokens.
    if (mcpServers.length > 0) {
      const entries = yield* mcpServerEntries(mcpServers, record.cwd)
      const servers = Context.get(
        yield* Layer.buildWithScope(McpServers.layer(entries), sessionScope),
        McpServers.McpServers,
      )
      const failures = Object.entries(yield* servers.status).flatMap(
        ([name, status]) =>
          status._tag === "Failed"
            ? [`MCP server "${name}" failed: ${status.error}`]
            : [],
      )
      if (failures.length > 0) mcpFailures = failures.join("\n")
      makeAgent = makeAgent.pipe(
        Effect.provideService(McpServers.McpServers, servers),
      )
    }
    const agent = yield* Scope.provide(makeAgent, sessionScope)
    MutableRef.set(agent.history, record.history)
    if (record.environment !== undefined) {
      MutableRef.set(agent.environment, record.environment)
    }
    const session: Session = {
      id,
      cwd: record.cwd,
      model: record.model,
      thoughtLevel: record.thoughtLevel,
      fastMode: record.fastMode ?? false,
      agent,
      running: undefined,
      toolCalls: 0,
      announcedSubagents: new Set(),
      scope: sessionScope,
      mcpFailures,
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

  // ---------------------------------------------------------------------
  // Prompt content blocks
  // ---------------------------------------------------------------------

  /**
   * Fetch an `http(s):` image. Any transport or non-2xx failure rejects the
   * prompt; nothing is retried here.
   */
  const fetchImage = Effect.fnUntraced(
    function* (uri: string) {
      if (Option.isNone(http)) {
        return yield* invalidParams(
          `Cannot fetch image ${uri}: no HttpClient available`,
        )
      }
      const response = yield* HttpClient.withScope(http.value).get(uri)
      if (response.status < 200 || response.status >= 300) {
        return yield* invalidParams(
          `Failed to fetch image ${uri}: HTTP ${response.status}`,
        )
      }
      const tooLarge = () =>
        invalidParams(
          `Image ${uri} exceeds the ${Image.maxInputBytes} byte download limit`,
        )
      if (Number(response.headers["content-length"]) > Image.maxInputBytes) {
        return yield* tooLarge()
      }
      return yield* Image.collectInput(response.stream, tooLarge)
    },
    Effect.scoped,
    Effect.timeout(remoteImageTimeout),
    (effect, uri) =>
      effect.pipe(
        Effect.mapError((error) =>
          error instanceof RpcError
            ? error
            : invalidParams(`Failed to fetch image ${uri}: ${error.message}`),
        ),
      ),
  )

  /**
   * Read a `file:` image, but only when its real path (symlinks resolved)
   * is inside the session directory (symlinks resolved as well).
   */
  const readLocalImage = (
    cwd: string,
    uri: string,
  ): Effect.Effect<Uint8Array, RpcError> =>
    Option.match(Option.all([fs, path]), {
      onNone: () =>
        Effect.fail(
          invalidParams(`Cannot read image ${uri}: no FileSystem available`),
        ),
      onSome: ([fs, path]) =>
        Effect.gen(function* () {
          const url = yield* Effect.try({
            try: () => new URL(uri),
            catch: () => invalidParams(`Invalid file URI: ${uri}`),
          })
          const filePath = yield* path
            .fromFileUrl(url)
            .pipe(
              Effect.mapError(() => invalidParams(`Invalid file URI: ${uri}`)),
            )
          const resolved = path.resolve(cwd, filePath)
          const [realCwd, real] = yield* Effect.all([
            fs.realPath(cwd),
            fs.realPath(resolved),
          ]).pipe(
            Effect.mapError(() =>
              invalidParams(`Image file not found: ${uri}`),
            ),
          )
          if (real !== realCwd && !real.startsWith(realCwd + path.sep)) {
            return yield* invalidParams(
              `Image file is outside the session directory: ${uri}`,
            )
          }
          return yield* Image.readBoundedFile(fs, real).pipe(
            Effect.mapError((error) =>
              invalidParams(`Failed to read image ${uri}: ${error.message}`),
            ),
          )
        }),
    })

  const resolveImageUri = (
    cwd: string,
    uri: string,
  ): Effect.Effect<Uint8Array, RpcError> => {
    if (/^https?:\/\//i.test(uri)) return fetchImage(uri)
    if (/^file:/i.test(uri)) return readLocalImage(cwd, uri)
    return Effect.fail(invalidParams(`Unsupported image URI scheme: ${uri}`))
  }

  /**
   * Turn raw image bytes into a prompt part, sniffing the real type and
   * applying the shared size limits.
   */
  const imagePart = Effect.fnUntraced(function* (
    bytes: Uint8Array,
    declared: string | undefined,
    fileName: string | undefined,
  ) {
    const mediaType = Option.getOrElse(Image.mediaTypeFromBytes(bytes), () =>
      declared !== undefined && Image.isImageMediaType(declared)
        ? declared
        : undefined,
    )
    if (mediaType === undefined) {
      return yield* invalidParams(
        `Unsupported image type${declared === undefined ? "" : `: ${declared}`}`,
      )
    }
    const prepared = yield* Image.prepare({ data: bytes, mediaType }).pipe(
      Effect.mapError((error) => invalidParams(error.message)),
    )
    return Prompt.makePart("file", {
      mediaType: prepared.mediaType,
      ...(fileName === undefined ? {} : { fileName }),
      data: prepared.data,
    })
  })

  /**
   * Map ACP content blocks onto one user message. Text-like blocks are
   * joined into text parts; image blocks become `file` parts in place.
   */
  const promptFromBlocks = Effect.fnUntraced(function* (
    cwd: string,
    blocks: ReadonlyArray<typeof ContentBlock.Type>,
  ): Effect.fn.Return<Prompt.RawInput, RpcError> {
    const parts: Array<Prompt.UserMessagePart> = []
    let text: Array<string> = []
    const flush = () => {
      if (text.length === 0) return
      parts.push(Prompt.makePart("text", { text: text.join("\n\n") }))
      text = []
    }
    const addImage = (part: Prompt.FilePart) => {
      flush()
      parts.push(part)
    }

    for (const block of blocks) {
      switch (block.type) {
        case "text":
          text.push(block.text)
          break
        case "image": {
          const bytes =
            block.data.length > 0
              ? yield* decodeBase64(block.data, "image block")
              : block.uri !== undefined
                ? yield* resolveImageUri(cwd, block.uri)
                : yield* invalidParams("Image block has no data")
          addImage(
            yield* imagePart(bytes, block.mimeType, fileNameOf(block.uri)),
          )
          break
        }
        case "resource_link": {
          if (
            block.mimeType !== undefined &&
            Image.isImageMediaType(block.mimeType)
          ) {
            const bytes = yield* resolveImageUri(cwd, block.uri)
            addImage(
              yield* imagePart(
                bytes,
                block.mimeType,
                block.name ?? fileNameOf(block.uri),
              ),
            )
          } else {
            text.push(renderLink(block.uri, block.name))
          }
          break
        }
        case "resource": {
          const { uri, mimeType, text: body, blob } = block.resource
          if (
            blob !== undefined &&
            mimeType !== undefined &&
            Image.isImageMediaType(mimeType)
          ) {
            const bytes = yield* decodeBase64(blob, `resource ${uri}`)
            addImage(yield* imagePart(bytes, mimeType, fileNameOf(uri)))
          } else if (body !== undefined) {
            text.push(`<resource uri="${uri}">\n${body}\n</resource>`)
          } else {
            text.push(renderLink(uri))
          }
          break
        }
      }
    }
    flush()
    return [{ role: "user", content: parts }]
  })

  const runTurn = Effect.fnUntraced(function* (
    session: Session,
    prompt: Prompt.RawInput,
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
            title: `terminal: ${script.replace(/\s+/g, " ").trim().slice(0, 120)}`,
            kind: "execute",
            status: "in_progress",
            rawInput: { command: script },
            content: [{ type: "content", content: textContent(script) }],
          })
        case "ScriptOutput":
          return update(session.id, {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: part.output,
            content: [{ type: "content", content: textContent(part.output) }],
          })
        case "Usage":
          return update(session.id, {
            sessionUpdate: "usage_update",
            used: Number.isFinite(part.contextTokens)
              ? Math.max(0, Math.round(part.contextTokens))
              : 0,
            size,
            usage: {
              inputTokens: Math.max(
                0,
                part.inputTokens - part.cacheRead - part.cacheWrite,
              ),
              outputTokens: part.outputTokens,
              cachedReadTokens: part.cacheRead,
              cachedWriteTokens: part.cacheWrite,
            },
          })
        case "ErrorRetry":
          return update(session.id, {
            sessionUpdate: "agent_thought_chunk",
            content: textContent(
              `Retrying after error: ${part.error.message}\n`,
            ),
          })
        // A background agent's tool call stays in progress until the agent
        // finishes, while the parent keeps taking turns.
        case "SubagentStart": {
          const announced = session.announcedSubagents.has(part.id)
          session.announcedSubagents.add(part.id)
          return update(session.id, {
            sessionUpdate: announced ? "tool_call_update" : "tool_call",
            toolCallId: `subagent-${part.id}`,
            title: `delegate: ${part.prompt.replace(/\s+/g, " ").trim().slice(0, 120)}`,
            kind: "think",
            status: "in_progress",
            rawInput: { prompt: part.prompt },
          })
        }
        case "SubagentComplete":
          return update(session.id, {
            sessionUpdate: "tool_call_update",
            toolCallId: `subagent-${part.id}`,
            status: part.status === "completed" ? "completed" : "failed",
            rawOutput: part.summary,
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
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      mcpCapabilities: { http: true, sse: false },
      sessionCapabilities: { close: {} },
    },
    authMethods: [],
    agentInfo: { name: "clanka", version: options.version },
  })

  const newSession = Effect.fnUntraced(function* (params: unknown) {
    const { cwd, model, mcpServers } = yield* decodeParams(
      NewSessionParams,
      params,
    )
    const modelId = model ?? options.defaultModel
    const thoughtLevel = options.defaultThoughtLevel
    const fastMode = options.defaultFastMode ?? false
    yield* requireModel(modelId, thoughtLevel, fastMode)
    const session = yield* openSession(
      crypto.randomUUID(),
      new SessionRecord({
        cwd,
        model: modelId,
        thoughtLevel,
        fastMode,
        history: Prompt.empty,
      }),
      mcpServers ?? [],
    )
    yield* persist(session)
    return { sessionId: session.id, ...(yield* sessionState(session)) }
  })

  const loadSession = Effect.fnUntraced(function* (
    params: unknown,
    replay: boolean,
  ) {
    const { sessionId, cwd, model, mcpServers } = yield* decodeParams(
      LoadSessionParams,
      params,
    )
    const existing = sessions.get(sessionId)
    if (existing !== undefined) {
      return yield* sessionState(existing)
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
    const fastMode = record.value.fastMode ?? false
    yield* requireModel(modelId, record.value.thoughtLevel, fastMode)
    const session = yield* openSession(
      sessionId,
      new SessionRecord({
        cwd: cwd ?? record.value.cwd,
        model: modelId,
        thoughtLevel: record.value.thoughtLevel,
        fastMode,
        history: record.value.history,
        // The stored environment belongs to the stored cwd.
        ...(record.value.environment !== undefined &&
        (cwd === undefined || cwd === record.value.cwd)
          ? { environment: record.value.environment }
          : {}),
      }),
      mcpServers ?? [],
    )
    if (replay) {
      yield* replayHistory(session)
    }
    return yield* sessionState(session)
  })

  const setModel = Effect.fnUntraced(function* (params: unknown) {
    const { sessionId, modelId } = yield* decodeParams(SetModelParams, params)
    const session = yield* getSession(sessionId)
    yield* requireModel(modelId, session.thoughtLevel, session.fastMode)
    session.model = modelId
    yield* persist(session)
    return { configOptions: configOptions(session) }
  })

  const setConfigOption = Effect.fnUntraced(function* (params: unknown) {
    const option = yield* decodeParams(SetConfigOptionParams, params)
    const session = yield* getSession(option.sessionId)
    if (option.configId === "thought_level") {
      yield* requireModel(session.model, option.value, session.fastMode)
      session.thoughtLevel = option.value
    } else {
      const fastMode = option.value === "on"
      if (fastMode && !supportsFastMode(session.model)) {
        return yield* invalidParams(
          `Fast mode is not supported by model: ${session.model}`,
        )
      }
      yield* requireModel(session.model, session.thoughtLevel, fastMode)
      session.fastMode = fastMode
    }
    yield* persist(session)
    return { configOptions: configOptions(session) }
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
    const model = yield* requireModel(
      session.model,
      session.thoughtLevel,
      session.fastMode,
    )
    // Resolve images before the turn starts, so a bad block rejects the
    // request without a model call.
    const input = yield* promptFromBlocks(session.cwd, prompt)
    if (session.mcpFailures !== undefined) {
      yield* update(sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: textContent(session.mcpFailures),
      })
      session.mcpFailures = undefined
    }
    session.running = yield* runTurn(session, input).pipe(
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

  // Ends the session in this process: its prompt, Agent and MCP servers. It
  // can be loaded again from the store.
  const closeSession = Effect.fnUntraced(function* (params: unknown) {
    const { sessionId } = yield* decodeParams(SessionIdParams, params)
    const session = yield* getSession(sessionId)
    sessions.delete(sessionId)
    if (session.running !== undefined) {
      yield* Fiber.interrupt(session.running)
    }
    yield* Scope.close(session.scope, Exit.void)
    return {}
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
        return Effect.succeed({})
      case "session/set_config_option":
        return setConfigOption(params)
      case "session/new":
        return newSession(params)
      case "session/load":
        return loadSession(params, true)
      case "session/resume":
        return loadSession(params, false)
      case "session/close":
        return closeSession(params)
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

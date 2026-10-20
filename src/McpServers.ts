/**
 * MCP servers whose tools scripts call as `mcp.<server>.<tool>(…)`.
 *
 * The servers connect when the layer is built and stay connected until its
 * scope closes. Their tools become loop-side handlers of the Agent, and their
 * type declarations are only returned by the `searchTools` function.
 *
 * @since 1.0.0
 */
import * as NodePath from "node:path"
import type { Readable } from "node:stream"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import {
  type CallToolResult,
  ErrorCode,
  McpError,
  type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as JsonSchema from "effect/JsonSchema"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Record from "effect/Record"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaRepresentation from "effect/SchemaRepresentation"
import * as Stream from "effect/Stream"
import type { LoopToolHandlers } from "./AgentExecutor.ts"
import { defaultMcpCallTimeout, type ImageAttachment } from "./AgentTools.ts"
import * as Image from "./Image.ts"
import * as TypeBuilder from "./TypeBuilder.ts"

// =============================================================================
// Config
// =============================================================================

const Timeout = Schema.Duration

/**
 * A server started as a child process and spoken to over stdio.
 *
 * @since 1.0.0
 * @category Config
 */
export const StdioServerConfig = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.RedactedFromValue(Schema.String)),
  ),
  /**
   * Resolved against the process cwd. Defaults to the process cwd.
   */
  cwd: Schema.optionalKey(Schema.String),
  connectTimeout: Schema.optionalKey(Timeout),
  callTimeout: Schema.optionalKey(Timeout),
})

/**
 * A server reached over streamable HTTP.
 *
 * @since 1.0.0
 * @category Config
 */
export const HttpServerConfig = Schema.Struct({
  type: Schema.Literal("http"),
  url: Schema.String,
  headers: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.RedactedFromValue(Schema.String)),
  ),
  connectTimeout: Schema.optionalKey(Timeout),
  callTimeout: Schema.optionalKey(Timeout),
})

/**
 * @since 1.0.0
 * @category Config
 */
export const McpServerConfig = Schema.Union([
  StdioServerConfig,
  HttpServerConfig,
])

/**
 * @since 1.0.0
 * @category Config
 */
export type McpServerConfig = typeof McpServerConfig.Type

/**
 * A server that cannot be started, such as one whose configuration refers to
 * a missing environment variable. It is reported as `Failed` with `error`.
 *
 * @since 1.0.0
 * @category Config
 */
export interface UnavailableServer {
  readonly type: "unavailable"
  readonly error: string
}

/**
 * @since 1.0.0
 * @category Config
 */
export type ServerEntry = McpServerConfig | UnavailableServer

/**
 * A server reached through a transport the caller builds. `transport` is
 * called once, when the layer is built.
 *
 * @since 1.0.0
 * @category Config
 */
export interface TransportServer {
  readonly transport: () => Transport
  readonly connectTimeout?: Duration.Input | undefined
  readonly callTimeout?: Duration.Input | undefined
}

const defaultConnectTimeout = Duration.seconds(30)

// =============================================================================
// Status
// =============================================================================

/**
 * @since 1.0.0
 * @category Status
 */
export class Connected extends Data.TaggedClass("Connected")<{
  /**
   * The names of every tool the server listed.
   */
  readonly tools: ReadonlyArray<string>
  readonly instructions: Option.Option<string>
}> {}

/**
 * @since 1.0.0
 * @category Status
 */
export class Failed extends Data.TaggedClass("Failed")<{
  readonly error: string
}> {}

/**
 * @since 1.0.0
 * @category Status
 */
export type ServerStatus = Connected | Failed

// =============================================================================
// Service
// =============================================================================

/**
 * @since 1.0.0
 * @category Services
 */
export class McpServers extends Context.Service<
  McpServers,
  {
    /**
     * Each server by its configured name.
     */
    readonly status: Effect.Effect<Readonly<Record<string, ServerStatus>>>
    /**
     * The system prompt section listing the servers, or `""` when none is
     * configured.
     */
    readonly prompt: string
    /**
     * The declaration of `searchTools`, or `""` when no server is connected.
     */
    readonly dts: string
    /**
     * The loop-side handlers: one per tool, keyed `"<server>.<tool>"`, and
     * `searchTools`. Images in results go to `onImage`.
     */
    readonly handlers: (
      onImage: (image: ImageAttachment) => Effect.Effect<void>,
    ) => LoopToolHandlers
  }
>()("clanka/McpServers") {}

/**
 * Connects every server when built and closes them with its scope. A server
 * that cannot connect is `Failed`; building the layer never fails.
 *
 * @since 1.0.0
 * @category Layers
 */
export const layer = (
  config: Readonly<Record<string, ServerEntry>>,
): Layer.Layer<McpServers> =>
  fromEntries(
    Object.entries(config).map(([name, entry]) => toEntry(name, entry)),
  )

/**
 * Like `layer`, with transports built by the caller.
 *
 * @since 1.0.0
 * @category Layers
 */
export const layerTransports = (
  servers: Readonly<Record<string, TransportServer>>,
): Layer.Layer<McpServers> =>
  fromEntries(
    Object.entries(servers).map(([name, server]) => ({
      name,
      open: () => ({ transport: server.transport(), stderr: undefined }),
      connectTimeout: server.connectTimeout,
      callTimeout: server.callTimeout,
    })),
  )

const fromEntries = (entries: ReadonlyArray<Entry>): Layer.Layer<McpServers> =>
  Layer.effect(McpServers, make(entries))

// =============================================================================
// Naming
// =============================================================================

const reservedWords = new Set([
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
])

/**
 * The JavaScript identifier a server or tool name is offered under.
 *
 * @since 1.0.0
 * @category Naming
 */
export const identifier = (name: string): string => {
  let id = name.replace(/[^A-Za-z0-9_$]/g, "_")
  if (id === "" || /^[0-9]/.test(id)) id = `_${id}`
  return reservedWords.has(id) ? `${id}_` : id
}

// =============================================================================
// Connecting
// =============================================================================

interface Opened {
  readonly transport: Transport
  readonly stderr: Readable | undefined
}

type Entry =
  | {
      readonly name: string
      readonly open: () => Opened
      readonly connectTimeout?: Duration.Input | undefined
      readonly callTimeout?: Duration.Input | undefined
    }
  | { readonly name: string; readonly error: string }

const toEntry = (name: string, entry: ServerEntry): Entry => {
  switch (entry.type) {
    case "unavailable":
      return { name, error: entry.error }
    case "stdio":
      return {
        name,
        open: () => {
          const transport = new StdioClientTransport({
            command: entry.command,
            args: [...(entry.args ?? [])],
            env: { ...processEnv(), ...unwrapRecord(entry.env) },
            cwd: NodePath.resolve(process.cwd(), entry.cwd ?? "."),
            stderr: "pipe",
          })
          return {
            transport: transport as Transport,
            stderr: (transport.stderr as Readable | null) ?? undefined,
          }
        },
        connectTimeout: entry.connectTimeout,
        callTimeout: entry.callTimeout,
      }
    case "http":
      return {
        name,
        open: () => ({
          transport: new HttpTransport(
            new URL(entry.url),
            unwrapRecord(entry.headers),
          ) as Transport,
          stderr: undefined,
        }),
        connectTimeout: entry.connectTimeout,
        callTimeout: entry.callTimeout,
      }
  }
}

/**
 * The SDK transport with its retries stopped by `close`. The SDK reads
 * `maxRetries` when it schedules a retry, and a resumption GET that fails
 * after `close` would otherwise schedule another one.
 */
class HttpTransport extends StreamableHTTPClientTransport {
  readonly reconnection: { maxRetries: number }

  constructor(url: URL, headers: Record<string, string>) {
    // The SDK defaults.
    const reconnection = {
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 30000,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 2,
    }
    super(url, { requestInit: { headers }, reconnectionOptions: reconnection })
    this.reconnection = reconnection
  }

  override close(): Promise<void> {
    this.reconnection.maxRetries = 0
    return super.close()
  }
}

const processEnv = (): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  return env
}

const unwrapRecord = (
  record: Readonly<Record<string, Redacted.Redacted<string>>> | undefined,
): Record<string, string> => Record.map(record ?? {}, Redacted.value)

interface ToolEntry {
  readonly id: string
  /** The name the server knows the tool by. */
  readonly name: string
  readonly description: string | undefined
  readonly decode: Option.Option<
    (params: unknown) => Effect.Effect<unknown, string>
  >
  /** Whether the result is `structuredContent`. */
  readonly structured: boolean
  readonly dts: string
  readonly search: {
    readonly names: ReadonlyArray<string>
    readonly nameTokens: ReadonlySet<string>
    readonly parameterTokens: ReadonlySet<string>
    readonly description: string
  }
}

interface ConnectedServer {
  readonly _tag: "Connected"
  readonly name: string
  readonly id: string
  readonly callTimeout: Duration.Duration
  readonly client: Client
  readonly status: Connected
  readonly tools: ReadonlyArray<ToolEntry>
  /** Why the connection dropped, once it has. Nothing reconnects. */
  dropped: string | undefined
}

interface FailedServer {
  readonly _tag: "Failed"
  readonly name: string
  readonly id: string
  /** The reason, followed by the stderr tail when there is one. */
  readonly error: string
}

type ServerState = ConnectedServer | FailedServer

const currentStatus = (server: ServerState): ServerStatus => {
  if (server._tag === "Failed") return new Failed({ error: server.error })
  return server.dropped === undefined
    ? server.status
    : new Failed({ error: `disconnected: ${server.dropped}` })
}

/** The first line of a failure, for the system prompt. */
const shortReason = (error: string): string => error.split("\n")[0]!

// The rolling stderr buffer kept until a stdio server is connected.
const stderrLines = 20
const stderrChars = 2000

const make = Effect.fnUntraced(function* (entries: ReadonlyArray<Entry>) {
  const runFork = Effect.runForkWith(yield* Effect.context<never>())

  // Identifiers are claimed in config order, whether or not the server
  // connects.
  const owners = new Map<string, string>()
  const planned = entries.map((entry) => {
    const id = identifier(entry.name)
    const owner = owners.get(id)
    if (owner !== undefined) {
      return {
        id,
        entry: {
          name: entry.name,
          error: `identifier "${id}" is already used by server "${owner}"`,
        },
      }
    }
    owners.set(id, entry.name)
    return { id, entry }
  })

  const servers = yield* Effect.forEach(
    planned,
    ({ id, entry }) => connect(entry, id, runFork),
    { concurrency: "unbounded" },
  )

  const connected = servers.filter(
    (server): server is ConnectedServer => server._tag === "Connected",
  )
  const searchTools = makeSearchTools(connected)

  return McpServers.of({
    status: Effect.sync(() =>
      Object.fromEntries(
        servers.map((server) => [server.name, currentStatus(server)]),
      ),
    ),
    prompt: renderPrompt(servers),
    dts: connected.length > 0 ? searchToolsDts : "",
    handlers: (onImage) => {
      const handlers: Record<
        string,
        (params: unknown) => Effect.Effect<unknown, string>
      > = {}
      if (connected.length === 0) return handlers
      let images = 0
      const nextImage = () => ++images
      for (const server of connected) {
        for (const tool of server.tools) {
          handlers[`${server.id}.${tool.id}`] = callTool(
            server,
            tool,
            onImage,
            nextImage,
          )
        }
      }
      handlers["searchTools"] = searchTools
      return handlers
    },
  })
})

const connect = Effect.fnUntraced(function* (
  entry: Entry,
  id: string,
  runFork: <A, E>(effect: Effect.Effect<A, E>) => unknown,
) {
  const fail = (error: string) =>
    Effect.logWarning("MCP server failed").pipe(
      Effect.annotateLogs({ server: entry.name, error }),
      Effect.as<ServerState>({ _tag: "Failed", name: entry.name, id, error }),
    )

  if ("error" in entry) return yield* fail(entry.error)

  const opened = yield* Effect.result(
    Effect.try({ try: entry.open, catch: errorMessage }),
  )
  if (Result.isFailure(opened)) return yield* fail(opened.failure)
  const { transport, stderr } = opened.success

  // stderr goes to the debug log. Until the server is connected, its tail is
  // also kept for the failure message.
  let buffer: Array<string> | undefined = []
  const stderrReader = yield* Effect.forkScoped(
    stderr === undefined
      ? Effect.void
      : Stream.fromAsyncIterable(
          stderr as AsyncIterable<Uint8Array>,
          errorMessage,
        ).pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runForEach((line) => {
            if (buffer !== undefined) {
              buffer.push(line)
              while (
                buffer.length > stderrLines ||
                (buffer.length > 1 && buffer.join("\n").length > stderrChars)
              ) {
                buffer.shift()
              }
            }
            return Effect.logDebug(line).pipe(
              Effect.annotateLogs({ server: entry.name }),
            )
          }),
          Effect.ignore,
        ),
  )

  const client = new Client({ name: "clanka", version: "1.0.0" })
  // Failed initialization starts close without awaiting it. Retain that
  // promise so failure cleanup and scope finalization await the same shutdown.
  const close = client.close.bind(client)
  let closing: Promise<void> | undefined
  client.close = () => (closing ??= close())
  const logError = (error: Error) =>
    runFork(
      Effect.logDebug("MCP client error", error.message).pipe(
        Effect.annotateLogs({ server: entry.name }),
      ),
    )
  // The SDK client only has callback properties.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  client.onerror = logError
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => client.close().catch(() => undefined)),
  )

  const connectTimeout = Duration.fromInputUnsafe(
    entry.connectTimeout ?? defaultConnectTimeout,
  )
  const timeout = Duration.toMillis(connectTimeout)
  const listed = yield* Effect.tryPromise({
    try: async (signal) => {
      await client.connect(transport, { signal, timeout })
      const tools: Array<McpTool> = []
      let cursor: string | undefined = undefined
      do {
        // Each page needs the cursor of the one before.
        // oxlint-disable-next-line no-await-in-loop
        const page = await client.listTools(
          cursor === undefined ? undefined : { cursor },
          { signal, timeout },
        )
        tools.push(...page.tools)
        cursor = page.nextCursor
      } while (cursor !== undefined)
      // Every `listTools` call replaces the output validators with those of
      // its own page.
      ;(
        client as unknown as {
          cacheToolMetadata: (tools: ReadonlyArray<McpTool>) => void
        }
      ).cacheToolMetadata(tools)
      return tools
    },
    catch: errorMessage,
  }).pipe(
    Effect.timeoutOrElse({
      duration: connectTimeout,
      orElse: () => Effect.fail(`connection timed out after ${timeout}ms`),
    }),
    Effect.result,
  )

  if (Result.isFailure(listed)) {
    // Closing ends the process; give its last stderr lines a moment to arrive.
    yield* Effect.promise(() => client.close().catch(() => undefined))
    yield* Fiber.join(stderrReader).pipe(Effect.timeoutOption("500 millis"))
    const details = buffer.join("\n")
    buffer = undefined
    return yield* fail(
      details === "" ? listed.failure : `${listed.failure}\n${details}`,
    )
  }
  buffer = undefined

  const seen = new Set<string>()
  const tools: Array<ToolEntry> = []
  for (const tool of listed.success) {
    const toolId = identifier(tool.name)
    if (seen.has(toolId)) {
      yield* Effect.logWarning("MCP tool skipped").pipe(
        Effect.annotateLogs({
          server: entry.name,
          tool: tool.name,
          reason: `identifier "${toolId}" is already used`,
        }),
      )
      continue
    }
    seen.add(toolId)
    tools.push(yield* makeTool(entry.name, toolId, tool))
  }

  const server: ConnectedServer = {
    _tag: "Connected",
    name: entry.name,
    id,
    callTimeout: Duration.fromInputUnsafe(
      entry.callTimeout ?? defaultMcpCallTimeout,
    ),
    client,
    status: new Connected({
      tools: listed.success.map((tool) => tool.name),
      instructions: Option.fromNullishOr(client.getInstructions()),
    }),
    tools,
    dropped: undefined,
  }
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  client.onclose = () => {
    server.dropped ??= "connection closed"
  }
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  client.onerror = (error) => {
    // A 404 on a request carrying the session ID means the server ended the
    // session. The SDK only reports it, and nothing starts a new session.
    if (
      error instanceof StreamableHTTPError &&
      error.code === 404 &&
      transport instanceof StreamableHTTPClientTransport &&
      transport.sessionId !== undefined
    ) {
      server.dropped ??= error.message
      void client.close().catch(() => undefined)
    }
    logError(error)
  }
  return server
})

// =============================================================================
// Tool declarations
// =============================================================================

const importSchema = (schema: object): Schema.Top => {
  const json = schema as JsonSchema.JsonSchema
  const document =
    typeof json["$schema"] === "string" && json["$schema"].includes("draft-07")
      ? JsonSchema.fromSchemaDraft07(json)
      : JsonSchema.fromSchemaDraft2020_12(json)
  return SchemaRepresentation.fromJsonSchemaDocument(document, {
    patterns: "ignore",
  })
}

const indentRest = (text: string, indent: string): string =>
  text.split("\n").join(`\n${indent}`)

const makeTool = Effect.fnUntraced(function* (
  serverName: string,
  id: string,
  tool: McpTool,
) {
  // A schema the importer rejects leaves the tool unvalidated, typed as a
  // record with the raw schema in its doc comment.
  const input = yield* Effect.try({
    try: () => {
      const schema = importSchema(tool.inputSchema) as Schema.Codec<unknown>
      const decodeParams = Schema.decodeUnknownEffect(schema)
      return {
        parameters: TypeBuilder.render(schema),
        decode: Option.some((params: unknown) =>
          decodeParams(params, { onExcessProperty: "error" }).pipe(
            Effect.mapError((error) => error.message),
          ),
        ),
        fallback: undefined,
      }
    },
    catch: errorMessage,
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("MCP tool schema not imported").pipe(
        Effect.annotateLogs({ server: serverName, tool: tool.name, error }),
        Effect.as({
          parameters: "Record<string, unknown>",
          decode: Option.none(),
          fallback: `Input JSON Schema:\n${JSON.stringify(tool.inputSchema, null, 2)}`,
        }),
      ),
    ),
  )
  const { parameters, decode, fallback } = input

  const outputSchema = tool.outputSchema
  const result =
    outputSchema === undefined
      ? "string"
      : yield* Effect.try(() =>
          TypeBuilder.render(importSchema(outputSchema), {
            omitUnknownIndexSignatures: true,
          }),
        ).pipe(Effect.orElseSucceed(() => "unknown"))

  const docs = [tool.description, fallback].filter(
    (text): text is string => text !== undefined && text !== "",
  )
  const signature = `  function ${id}(options: ${indentRest(parameters, "  ")}): Promise<${indentRest(result, "  ")}>`
  const parameterNames = Object.keys(tool.inputSchema.properties ?? {})

  return {
    id,
    name: tool.name,
    description: tool.description,
    decode,
    structured: tool.outputSchema !== undefined,
    dts:
      docs.length === 0
        ? signature
        : `${TypeBuilder.renderJsDoc(docs.join("\n\n"), "  ")}\n${signature}`,
    search: {
      names: [tool.name.toLowerCase(), id.toLowerCase()],
      nameTokens: new Set([...tokens(tool.name), ...tokens(id)]),
      parameterTokens: new Set(parameterNames.flatMap(tokens)),
      description: (tool.description ?? "").toLowerCase(),
    },
  } satisfies ToolEntry
})

// =============================================================================
// Discovery
// =============================================================================

const searchToolsDts = `/**
 * List every tool on a server:
 *
 *     console.log(await searchTools({ server: "github" }))
 *
 * Search all servers by keyword, for at most 10 tools:
 *
 *     console.log(await searchTools({ query: "create issue" }))
 *
 * Both return the tools' type declarations. Print them before calling a tool.
 * A \`query\` with a \`server\` searches only that server.
 */
declare function searchTools(options: {
    readonly query?: string;
    readonly server?: string;
}): Promise<string>`

const SearchParams = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  server: Schema.optionalKey(Schema.String),
})

// The most tools a query returns. Listing a server returns all of them.
const maxResults = 10

const tokens = (text: string): Array<string> =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== "")

const score = (
  tool: ToolEntry,
  query: { readonly text: string; readonly tokens: ReadonlyArray<string> },
): number => {
  let total = tool.search.names.includes(query.text) ? 1000 : 0
  for (const token of query.tokens) {
    if (tool.search.nameTokens.has(token)) total += 10
    else if (tool.search.names.some((name) => name.includes(token))) total += 5
    if (tool.search.parameterTokens.has(token)) total += 3
    if (tool.search.description.includes(token)) total += 2
  }
  return total
}

const makeSearchTools = (servers: ReadonlyArray<ConnectedServer>) => {
  const decode = Schema.decodeUnknownEffect(SearchParams)
  const serverList = servers.map((server) => server.id).join(", ")
  const counts = servers
    .map((server) => `${server.id} (${server.status.tools.length} tools)`)
    .join(", ")

  return Effect.fnUntraced(function* (
    params: unknown,
  ): Effect.fn.Return<string, string> {
    const options = yield* decode(params ?? {}).pipe(
      Effect.mapError((error) => `searchTools: ${error.message}`),
    )
    const query = options.query?.trim() ?? ""
    let candidates = servers
    if (options.server !== undefined) {
      const server = servers.find(
        (server) =>
          server.id === options.server || server.name === options.server,
      )
      if (server === undefined) {
        return yield* Effect.fail(
          `searchTools: unknown MCP server "${options.server}". Servers: ${serverList}`,
        )
      }
      if (query === "") return renderTools([[server, server.tools]])
      candidates = [server]
    } else if (query === "") {
      return yield* Effect.fail(
        `searchTools: pass a query or a server. Servers: ${serverList}`,
      )
    }

    const terms = { text: query.toLowerCase(), tokens: tokens(query) }
    const ranked = candidates
      .flatMap((server) =>
        server.tools.map((tool) => ({
          server,
          tool,
          score: score(tool, terms),
        })),
      )
      .filter((match) => match.score > 0)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, maxResults)
    if (ranked.length === 0) {
      return `No MCP tools match "${query}". Servers: ${counts}.`
    }
    const groups = new Map<ConnectedServer, Array<ToolEntry>>()
    for (const { server, tool } of ranked) {
      const group = groups.get(server)
      if (group === undefined) groups.set(server, [tool])
      else group.push(tool)
    }
    return renderTools([...groups])
  })
}

const renderTools = (
  groups: ReadonlyArray<readonly [ConnectedServer, ReadonlyArray<ToolEntry>]>,
): string =>
  groups
    .map(
      ([server, tools]) =>
        `declare namespace mcp.${server.id} {\n${tools.map((tool) => tool.dts).join("\n\n")}\n}`,
    )
    .join("\n\n")

// =============================================================================
// Calls
// =============================================================================

const callTool = (
  server: ConnectedServer,
  tool: ToolEntry,
  onImage: (image: ImageAttachment) => Effect.Effect<void>,
  nextImage: () => number,
) => {
  const name = `${server.id}.${tool.id}`
  const prefix = `mcp.${name}:`
  const timeout = Duration.toMillis(server.callTimeout)
  const timedOut = `${prefix} timed out after ${timeout}ms`
  return Effect.fnUntraced(function* (
    params: unknown,
  ): Effect.fn.Return<unknown, string> {
    if (server.dropped !== undefined) {
      return yield* Effect.fail(
        `${prefix} MCP server "${server.name}" is not connected: ${server.dropped}`,
      )
    }
    const args = params ?? {}
    if (Option.isSome(tool.decode)) {
      yield* tool.decode
        .value(args)
        .pipe(Effect.mapError((message) => `${prefix} ${message}`))
    }
    const result = (yield* Effect.tryPromise({
      try: (signal) =>
        server.client.callTool(
          { name: tool.name, arguments: args as Record<string, unknown> },
          undefined,
          { signal, timeout },
        ),
      catch: (error) =>
        error instanceof McpError && error.code === ErrorCode.RequestTimeout
          ? timedOut
          : `${prefix} ${errorMessage(error)}`,
    }).pipe(
      Effect.timeoutOrElse({
        duration: server.callTimeout,
        orElse: () => Effect.fail(timedOut),
      }),
    )) as CallToolResult
    if (result.isError !== true && tool.structured) {
      return result.structuredContent
    }
    const text = yield* renderContent(result.content ?? [], {
      name,
      onImage,
      nextImage,
    })
    if (result.isError === true) {
      return yield* Effect.fail(
        `${prefix} ${text === "" ? "tool returned an error with no message" : text}`,
      )
    }
    return text
  })
}

const extensions: Record<Image.ImageMediaType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

const renderContent = Effect.fnUntraced(function* (
  content: CallToolResult["content"],
  options: {
    readonly name: string
    readonly onImage: (image: ImageAttachment) => Effect.Effect<void>
    readonly nextImage: () => number
  },
) {
  const parts: Array<string> = []
  for (const block of content) {
    switch (block.type) {
      case "text":
        parts.push(block.text)
        break
      case "image": {
        if (!Image.isImageMediaType(block.mimeType)) {
          parts.push(`[Image omitted (${block.mimeType}): unsupported type]`)
          break
        }
        const decoded = Base64.decode(block.data)
        if (Result.isFailure(decoded)) {
          parts.push(`[Image omitted (${block.mimeType}): invalid base64 data]`)
          break
        }
        const bytes = decoded.success
        const prepared = yield* Effect.exit(
          Image.prepare({
            data: bytes,
            mediaType: Option.getOrElse(
              Image.mediaTypeFromBytes(bytes),
              () => block.mimeType as Image.ImageMediaType,
            ),
          }),
        )
        if (Exit.isFailure(prepared)) {
          const error = Option.match(Exit.findErrorOption(prepared), {
            onNone: () => "the image could not be read",
            onSome: (error) => error.message,
          })
          parts.push(`[Image omitted (${block.mimeType}): ${error}]`)
          break
        }
        const fileName = `${options.name}-${options.nextImage()}.${extensions[prepared.value.mediaType]}`
        yield* options.onImage({
          fileName,
          mediaType: prepared.value.mediaType,
          data: prepared.value.data,
        })
        parts.push(`[Image attached: ${fileName}]`)
        break
      }
      case "audio":
        parts.push(`[Audio omitted (${block.mimeType})]`)
        break
      case "resource":
        parts.push(
          "text" in block.resource && typeof block.resource.text === "string"
            ? `[Resource ${block.resource.uri}]\n${block.resource.text}`
            : `[Binary resource omitted: ${block.resource.uri} (${block.resource.mimeType ?? "unknown type"})]`,
        )
        break
      case "resource_link":
        parts.push(`[Resource link: ${block.name} ${block.uri}]`)
        break
    }
  }
  return parts.join("\n")
})

// =============================================================================
// System prompt
// =============================================================================

const maxInstructions = 2000

const renderPrompt = (servers: ReadonlyArray<ServerState>): string => {
  if (servers.length === 0) return ""
  const anyConnected = servers.some((server) => server._tag === "Connected")
  const lines = servers.map((server) => {
    if (server._tag === "Failed") {
      return `- ${server.name}: failed to connect: ${shortReason(server.error)}`
    }
    const header = `- ${server.id} (${server.status.tools.length} tools). List them with \`searchTools({ server: ${JSON.stringify(server.id)} })\`.`
    return Option.match(server.status.instructions, {
      onNone: () => header,
      onSome: (instructions) => {
        const text =
          instructions.length > maxInstructions
            ? `${instructions.slice(0, maxInstructions)}\n[instructions truncated]`
            : instructions
        return `${header} Its instructions:\n\n${text.trim()}\n`
      },
    })
  })
  return `# MCP servers
${
  anyConnected
    ? `
MCP tools are called as \`mcp.<server>.<tool>(options)\`. Their types are not listed above: list a server's tools with \`searchTools({ server })\`, or search across all servers by keyword with \`searchTools({ query })\`, and print the declarations before calling a tool. Images in their results are attached to the next message.
`
    : ""
}
${lines.join("\n")}`
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

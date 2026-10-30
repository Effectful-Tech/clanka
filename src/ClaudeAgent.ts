/**
 * Runs Claude models through the Claude Agent SDK and the user's own
 * installed Claude Code. clanka keeps its agent loop, `execute` tool, system
 * prompt and history; Claude Code only makes the model calls.
 *
 * See `.specs/claude-agent.md`.
 *
 * @since 1.0.0
 */
import type * as Sdk from "@anthropic-ai/claude-agent-sdk"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as AiError from "effect/ai/AiError"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import * as Prompt from "effect/ai/Prompt"
import type * as Response from "effect/ai/Response"
import * as Tool from "effect/ai/Tool"
import * as Fs from "node:fs"
import * as Path from "node:path"
import { isDeepStrictEqual } from "node:util"
import packageJson from "../package.json" with { type: "json" }
import { AgentModelConfig } from "./Agent.ts"
import * as Image from "./Image.ts"

/**
 * The oldest Claude Code release clanka runs: the first to honour
 * `verbatimPrompts`.
 *
 * @since 1.0.0
 * @category Claude Code
 */
export const minimumClaudeCodeVersion = "2.1.248"

const serverName = "clanka"
const toolPrefix = `mcp__${serverName}__`

// Claude Code features that duplicate clanka's, or would hide its tool.
const isolationEnv = {
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  // clanka compacts its own history.
  DISABLE_AUTO_COMPACT: "1",
  CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
  // Tool search would defer clanka's only tool.
  ENABLE_TOOL_SEARCH: "false",
  CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
  // clanka caps tool output itself.
  MAX_MCP_OUTPUT_TOKENS: "200000",
  // Skips OAuth, so a subscription login would not be used.
  CLAUDE_CODE_SIMPLE: undefined,
  // Would override the effort clanka sends.
  CLAUDE_CODE_EFFORT_LEVEL: undefined,
  // Would cap every `execute` call.
  MCP_TOOL_TIMEOUT: undefined,
}

/**
 * Options for a model. `effort: null` sends no effort, for models that
 * accept none; `"none"` turns thinking off.
 *
 * @since 1.0.0
 * @category Models
 */
export interface ModelOptions {
  readonly effort?: string | null | undefined
  /**
   * The Claude Code executable. Defaults to `CLANKA_CLAUDE_PATH`, then
   * `claude` on the `PATH`.
   */
  readonly executable?: string | undefined
  /**
   * Claude Code's working directory. Defaults to `process.cwd()`.
   */
  readonly cwd?: string | undefined
  readonly supportsImages?: boolean | undefined
  /**
   * The SDK's `query` function. Defaults to the one from
   * `@anthropic-ai/claude-agent-sdk`, loaded on first use.
   */
  readonly query?: typeof Sdk.query | undefined
}

/**
 * The Claude Agent SDK options for a session: Claude Code runs with none of
 * its own tools, settings, hooks, memory, skills or transcripts, and with the
 * system prompt from `prompt`.
 *
 * @since 1.0.0
 * @category Claude Code
 */
export const queryOptions = (options: {
  readonly model: string
  readonly prompt: Prompt.Prompt
  readonly cwd: string
  readonly pathToClaudeCodeExecutable: string
  readonly effort?: string | null | undefined
}): Sdk.Options => ({
  pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
  cwd: options.cwd,
  model: options.model,
  ...effortOptions(options.effort),
  systemPrompt: { type: "custom", prompt: systemText(options.prompt) },
  env: {
    ...process.env,
    ...isolationEnv,
    CLAUDE_AGENT_SDK_CLIENT_APP: `clanka/${packageJson.version}`,
  },
  settingSources: [],
  settings: { disableAllHooks: true },
  strictMcpConfig: true,
  skills: [],
  tools: [],
  permissionMode: "dontAsk",
  allowedTools: [`${toolPrefix}*`],
  verbatimPrompts: true,
  includePartialMessages: true,
  persistSession: false,
})

const efforts: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

const effortOptions = (
  effort: string | null | undefined,
): Pick<Sdk.Options, "effort" | "thinking"> => {
  if (effort === "none") return { thinking: { type: "disabled" } }
  const thinking = { type: "adaptive", display: "summarized" } as const
  if (effort === "minimal") return { thinking, effort: "low" }
  return effort !== null && effort !== undefined && efforts.has(effort)
    ? { thinking, effort: effort as Sdk.EffortLevel }
    : { thinking }
}

const systemText = (prompt: Prompt.Prompt) =>
  prompt.content
    .flatMap((message) => (message.role === "system" ? [message.content] : []))
    .join("\n\n")

/**
 * A content block of a Claude Code user message.
 *
 * @since 1.0.0
 * @category Messages
 */
export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image"
      readonly source: {
        readonly type: "base64"
        readonly media_type: Image.ImageMediaType
        readonly data: string
      }
    }

const render = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value)

const renderParams = (params: unknown) =>
  typeof params === "object" && params !== null && !Array.isArray(params)
    ? Object.entries(params)
        .map(([key, value]) => `<${key}>\n${render(value)}\n</${key}>`)
        .join("\n")
    : render(params)

/**
 * A prompt as the content of one Claude Code user message. A `query()` takes
 * no assistant history, so when the prompt has earlier turns each message is
 * wrapped in a `<role>` tag. Images become image blocks; the system message
 * is left out, it goes in `queryOptions`.
 *
 * @since 1.0.0
 * @category Messages
 */
export const toUserContent = (prompt: Prompt.Prompt): Array<ContentBlock> => {
  const blocks: Array<ContentBlock> = []
  let text: Array<string> = []
  const flush = () => {
    if (text.length === 0) return
    blocks.push({ type: "text", text: text.join("\n") })
    text = []
  }
  const history = prompt.content.some(
    (message) => message.role === "assistant" || message.role === "tool",
  )
  for (const message of prompt.content) {
    if (message.role === "system") continue
    if (history) text.push(`<${message.role}>`)
    for (const part of message.content) {
      switch (part.type) {
        case "text":
          text.push(part.text)
          break
        case "file": {
          const bytes = Image.isImageMediaType(part.mediaType)
            ? Image.partBytes(part)
            : Option.none()
          if (Option.isNone(bytes)) {
            text.push(
              `[file ${part.fileName ?? ""} (${part.mediaType}) omitted]`,
            )
            break
          }
          flush()
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: part.mediaType as Image.ImageMediaType,
              data: Base64.encode(bytes.value),
            },
          })
          break
        }
        case "tool-call":
          text.push(
            `<tool-call id="${part.id}" name="${part.name}">\n${renderParams(part.params)}\n</tool-call>`,
          )
          break
        case "tool-result":
          text.push(
            `<tool-result id="${part.id}" name="${part.name}"${part.isFailure ? ' failed="true"' : ""}>\n${render(part.result)}\n</tool-result>`,
          )
          break
      }
    }
    if (history) text.push(`</${message.role}>`)
  }
  flush()
  return blocks
}

// =============================================================================
// Stream conversion
// =============================================================================

interface UsageCounts {
  input: number
  read: number
  write: number
  output: number
}

interface ApiUsage {
  readonly input_tokens?: number | null | undefined
  readonly cache_read_input_tokens?: number | null | undefined
  readonly cache_creation_input_tokens?: number | null | undefined
  readonly output_tokens?: number | null | undefined
}

// Claude Code reports the same API message several times, so each count
// keeps its maximum per message. Context size is the last call's input.
const makeUsage = () => {
  const messages = new Map<string, UsageCounts>()
  let last: string | undefined
  return {
    update(id: string, usage: ApiUsage | null | undefined) {
      if (usage === null || usage === undefined) return
      let counts = messages.get(id)
      if (counts === undefined) {
        counts = { input: 0, read: 0, write: 0, output: 0 }
        messages.set(id, counts)
        last = id
      }
      counts.input = Math.max(counts.input, usage.input_tokens ?? 0)
      counts.read = Math.max(counts.read, usage.cache_read_input_tokens ?? 0)
      counts.write = Math.max(
        counts.write,
        usage.cache_creation_input_tokens ?? 0,
      )
      counts.output = Math.max(counts.output, usage.output_tokens ?? 0)
    },
    // The result's usage sums the whole Claude Code turn, so it only counts
    // when this step saw no API message.
    result(usage: ApiUsage) {
      if (messages.size === 0) this.update("result", usage)
    },
    snapshot(): typeof Response.Usage.Encoded {
      let output = 0
      for (const counts of messages.values()) output += counts.output
      const lastCall = last === undefined ? undefined : messages.get(last)
      return {
        inputTokens: {
          uncached: lastCall?.input,
          total:
            lastCall === undefined
              ? undefined
              : lastCall.input + lastCall.read + lastCall.write,
          cacheRead: lastCall?.read,
          cacheWrite: lastCall?.write,
        },
        outputTokens: { total: output },
      }
    },
  }
}

const aiError = (reason: AiError.AiErrorReason) =>
  AiError.make({ module: "ClaudeAgent", method: "streamText", reason })

const unknownError = (description: string) =>
  aiError(new AiError.UnknownError({ description }))

const resultError = (
  message: Sdk.SDKResultMessage,
  code: Sdk.SDKAssistantMessageError | undefined,
): AiError.AiError | undefined => {
  const status =
    message.subtype === "success" ? message.api_error_status : undefined
  if (
    message.subtype === "success" &&
    !message.is_error &&
    (status === undefined || status === null || status < 400)
  ) {
    return undefined
  }
  const description =
    (message.subtype === "success"
      ? message.result
      : message.errors.join("\n")
    ).replaceAll("Please run /login", "Run `claude auth login`") ||
    `Claude Code could not finish its reply${status ? ` (HTTP ${status})` : ""}`
  switch (code) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
      return aiError(
        new AiError.AuthenticationError({ kind: "Unknown", description }),
      )
    case "invalid_request":
      return aiError(new AiError.InvalidRequestError({ description }))
  }
  // Claude Code has already retried, so nothing here is retryable.
  return aiError(
    /prompt is too long/i.test(description)
      ? new AiError.InvalidRequestError({ description })
      : new AiError.UnknownError({ description }),
  )
}

const makeConverter = () => {
  const usage = makeUsage()
  const streamed = new Set<string>()
  const blocks = new Map<number, "text" | "reasoning">()
  let messageId = ""
  let calledTools = false
  let errorCode: Sdk.SDKAssistantMessageError | undefined

  return (
    message: Sdk.SDKMessage,
  ): Effect.Effect<Array<Response.StreamPartEncoded>, AiError.AiError> => {
    const parts: Array<Response.StreamPartEncoded> = []
    if (
      message.type === "stream_event" &&
      message.parent_tool_use_id === null
    ) {
      const event = message.event
      switch (event.type) {
        case "message_start":
          messageId = event.message.id
          streamed.add(messageId)
          usage.update(messageId, event.message.usage)
          break
        case "content_block_start": {
          const id = `${messageId}:${event.index}`
          const block = event.content_block
          if (block.type === "text") {
            blocks.set(event.index, "text")
            parts.push({ type: "text-start", id })
            if (block.text)
              parts.push({ type: "text-delta", id, delta: block.text })
          } else if (block.type === "thinking") {
            blocks.set(event.index, "reasoning")
            parts.push({ type: "reasoning-start", id })
            if (block.thinking) {
              parts.push({ type: "reasoning-delta", id, delta: block.thinking })
            }
          }
          break
        }
        case "content_block_delta": {
          const id = `${messageId}:${event.index}`
          const delta = event.delta
          if (delta.type === "text_delta") {
            parts.push({ type: "text-delta", id, delta: delta.text })
          } else if (delta.type === "thinking_delta" && delta.thinking) {
            parts.push({ type: "reasoning-delta", id, delta: delta.thinking })
          }
          break
        }
        case "content_block_stop": {
          const kind = blocks.get(event.index)
          if (kind !== undefined) {
            parts.push({
              type: `${kind}-end`,
              id: `${messageId}:${event.index}`,
            })
            blocks.delete(event.index)
          }
          break
        }
        case "message_delta":
          usage.update(messageId, event.usage)
          break
        case "message_stop":
          // The step ends once Claude has called clanka's tool: its handler
          // waits for the result of the next step.
          if (calledTools) {
            parts.push({
              type: "finish",
              reason: "tool-calls",
              usage: usage.snapshot(),
            })
          }
          break
      }
    } else if (
      message.type === "assistant" &&
      message.parent_tool_use_id === null
    ) {
      // Synthetic API error messages are diagnostics; the result reports
      // the failure.
      if (message.error !== undefined) {
        errorCode = message.error
        return Effect.succeed(parts)
      }
      usage.update(message.message.id, message.message.usage)
      // Assistant messages repeat streamed content, so only use their text
      // when nothing was streamed.
      const replay = !streamed.has(message.message.id)
      message.message.content.forEach((block, index) => {
        const id = `${message.uuid}:${index}`
        if (block.type === "tool_use") {
          // Claude Code answers calls to tools clanka did not offer itself.
          if (!block.name.startsWith(toolPrefix)) return
          calledTools = true
          parts.push({
            type: "tool-call",
            id: block.id,
            name: block.name.slice(toolPrefix.length),
            params: block.input,
            providerExecuted: false,
          })
        } else if (replay && block.type === "text") {
          parts.push(
            { type: "text-start", id },
            { type: "text-delta", id, delta: block.text },
            { type: "text-end", id },
          )
        } else if (replay && block.type === "thinking") {
          parts.push(
            { type: "reasoning-start", id },
            { type: "reasoning-delta", id, delta: block.thinking },
            { type: "reasoning-end", id },
          )
        }
      })
    } else if (message.type === "result") {
      const error = resultError(message, errorCode)
      if (error !== undefined) return Effect.fail(error)
      usage.result(message.usage)
      parts.push({
        type: "finish",
        reason: message.stop_reason === "max_tokens" ? "length" : "stop",
        usage: usage.snapshot(),
      })
    }
    return Effect.succeed(parts)
  }
}

/**
 * Converts the Claude Agent SDK messages of one model step to response
 * parts, ending at the step's `finish` part. A step ends when Claude Code
 * finishes its turn, or after an API message that called clanka's tools.
 *
 * @since 1.0.0
 * @category Messages
 */
export const toStreamParts = <E, R>(
  self: Stream.Stream<Sdk.SDKMessage, E, R>,
): Stream.Stream<Response.StreamPartEncoded, E | AiError.AiError, R> =>
  Stream.suspend(() => {
    const convert = makeConverter()
    return self.pipe(
      Stream.mapEffect(convert),
      Stream.flattenIterable,
      Stream.takeUntil((part) => part.type === "finish"),
    )
  })

// =============================================================================
// Sessions
// =============================================================================

// A JS async iterable of user messages: the streaming input of a `query()`.
class InputQueue implements AsyncIterable<Sdk.SDKUserMessage> {
  private readonly items: Array<Sdk.SDKUserMessage> = []
  private wake: (() => void) | undefined
  private closed = false
  push(message: Sdk.SDKUserMessage) {
    this.items.push(message)
    this.wake?.()
  }
  close() {
    this.closed = true
    this.wake?.()
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      const item = this.items.shift()
      if (item !== undefined) {
        yield item
        continue
      }
      if (this.closed) return
      // oxlint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
      this.wake = undefined
    }
  }
}

const userMessage = (
  content: ReadonlyArray<ContentBlock>,
  priority?: "next",
): Sdk.SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: content as Array<ContentBlock> },
  parent_tool_use_id: null,
  ...(priority === undefined ? {} : { priority }),
})

interface CallToolResult {
  readonly content: Array<
    | { readonly type: "text"; readonly text: string }
    | {
        readonly type: "image"
        readonly data: string
        readonly mimeType: string
      }
  >
  readonly isError?: boolean
}

// The parked tool calls, keyed by the tool use id Claude Code tags each MCP
// call with. `onCall` reports each request as it arrives, `undefined` for an
// untagged one. A handler waits until the next step resolves its call with
// clanka's result.
const makeToolBridge = (onCall: (id: string | undefined) => void) => {
  const calls = new Map<
    string,
    {
      readonly promise: Promise<CallToolResult>
      readonly resolve: (result: CallToolResult) => void
    }
  >()
  const entry = (id: string) => {
    let call = calls.get(id)
    if (call === undefined) {
      let resolve!: (result: CallToolResult) => void
      const promise = new Promise<CallToolResult>((done) => {
        resolve = done
      })
      call = { promise, resolve }
      calls.set(id, call)
    }
    return call
  }
  return {
    async call(id: string | undefined): Promise<CallToolResult> {
      onCall(id)
      // Never guess which call an untagged request is.
      if (id === undefined) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing tool use id" }],
        }
      }
      const result = await entry(id).promise
      calls.delete(id)
      return result
    },
    resolve(id: string, result: CallToolResult) {
      entry(id).resolve(result)
    },
    cancel() {
      for (const call of calls.values()) {
        call.resolve({
          isError: true,
          content: [{ type: "text", text: "Cancelled" }],
        })
      }
      calls.clear()
    },
  }
}

type ToolBridge = ReturnType<typeof makeToolBridge>

const makeToolServer = (
  tools: ReadonlyArray<Tool.Any>,
  bridge: ToolBridge,
): Effect.Effect<Sdk.McpSdkServerConfigWithInstance, AiError.AiError> =>
  Effect.tryPromise({
    try: async () => {
      // Loaded on first use, like the SDK.
      const [{ Server }, { CallToolRequestSchema, ListToolsRequestSchema }] =
        await Promise.all([
          import("@modelcontextprotocol/sdk/server/index.js"),
          import("@modelcontextprotocol/sdk/types.js"),
        ])
      const server = new Server(
        { name: serverName, version: packageJson.version },
        { capabilities: { tools: {} } },
      )
      const definitions = tools.map((tool) => ({
        name: tool.name,
        description: Tool.getDescription(tool) ?? "",
        inputSchema: Tool.getJsonSchema(tool) as {
          readonly type: "object"
        },
        annotations: { readOnlyHint: false },
        _meta: { "anthropic/alwaysLoad": true },
      }))
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: definitions,
      }))
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const toolUseId = request.params._meta?.["claudecode/toolUseId"]
        return (await bridge.call(
          typeof toolUseId === "string" ? toolUseId : undefined,
        )) as any
      })
      return {
        type: "sdk" as const,
        name: serverName,
        // The SDK names the high-level McpServer, but connects any server.
        instance:
          server as unknown as Sdk.McpSdkServerConfigWithInstance["instance"],
      }
    },
    catch: (cause) =>
      unknownError(`Failed to start the clanka MCP server: ${String(cause)}`),
  })

const loadSdk = Effect.tryPromise({
  try: () => import("@anthropic-ai/claude-agent-sdk"),
  catch: () =>
    unknownError(
      "The claude provider needs @anthropic-ai/claude-agent-sdk. Install it next to clanka.",
    ),
})

const executableNames =
  process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"]

const findExecutable = Effect.suspend(() => {
  const configured = process.env.CLANKA_CLAUDE_PATH
  if (configured !== undefined && configured !== "") {
    return Effect.succeed(configured)
  }
  for (const dir of (process.env.PATH ?? "").split(Path.delimiter)) {
    for (const name of executableNames) {
      const candidate = Path.join(dir, name)
      try {
        Fs.accessSync(candidate, Fs.constants.X_OK)
        return Effect.succeed(candidate)
      } catch {}
    }
  }
  return Effect.fail(
    unknownError(
      "Claude Code was not found. Install Claude Code and run `claude auth login`, or set CLANKA_CLAUDE_PATH.",
    ),
  )
})

const compareVersions = (a: string, b: string) => {
  const left = a.split(/[.-]/).map(Number)
  const right = b.split(/[.-]/).map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

// What a session reads: the SDK's messages, and the MCP requests for
// clanka's tool as they park.
type SessionEvent =
  | Sdk.SDKMessage
  | { readonly type: "clanka_parked"; readonly id: string | undefined }

interface Session {
  readonly query: Sdk.Query
  readonly input: InputQueue
  readonly bridge: ToolBridge
  readonly messages: Queue.Queue<SessionEvent, AiError.AiError | Cause.Done>
  readonly scope: Scope.Closeable
  readonly toolNames: string
  // The prompt of the last step, and how that step ended. `undefined`
  // while a step runs.
  seen: ReadonlyArray<Prompt.Message>
  outcome:
    | {
        readonly _tag: "Tools" | "Stop"
        readonly calls: ReadonlyArray<Response.ToolCallPartEncoded>
        readonly text: string
      }
    | undefined
}

const closeSession = (session: Session) =>
  Effect.suspend(() => {
    session.bridge.cancel()
    session.input.close()
    session.query.close()
    return Scope.close(session.scope, Exit.void)
  })

const startSession = Effect.fnUntraced(function* (
  model: string,
  options: ModelOptions | undefined,
  provider: LanguageModel.ProviderOptions,
  withTools: boolean,
) {
  const query = options?.query ?? (yield* loadSdk).query
  const executable = options?.executable ?? (yield* findExecutable)
  const messages = yield* Queue.make<
    SessionEvent,
    AiError.AiError | Cause.Done
  >()
  const bridge = makeToolBridge((id) => {
    Queue.offerUnsafe(messages, { type: "clanka_parked", id })
  })
  const mcpServers = withTools
    ? { [serverName]: yield* makeToolServer(provider.tools, bridge) }
    : {}
  const input = new InputQueue()
  input.push(userMessage(toUserContent(provider.prompt)))
  if (!withTools) input.close()
  const session = query({
    prompt: input,
    options: {
      ...queryOptions({
        model,
        prompt: provider.prompt,
        cwd: options?.cwd ?? process.cwd(),
        pathToClaudeCodeExecutable: executable,
        effort: options?.effort,
      }),
      mcpServers,
    },
  })
  const scope = yield* Scope.make()
  yield* Stream.fromAsyncIterable(session, (cause) =>
    unknownError(`Claude Code failed: ${String(cause)}`),
  ).pipe(
    Stream.runForEach((message) => Queue.offer(messages, message)),
    Effect.matchCauseEffect({
      onSuccess: () => Queue.end(messages),
      onFailure: (cause) => Queue.failCause(messages, cause),
    }),
    Effect.forkIn(scope),
  )
  const live: Session = {
    query: session,
    input,
    bridge,
    messages,
    scope,
    toolNames: provider.tools.map((tool) => tool.name).join(","),
    seen: provider.prompt.content,
    outcome: undefined,
  }
  yield* Effect.tryPromise({
    try: () => session.initializationResult(),
    catch: (cause) =>
      unknownError(`Claude Code failed to start: ${String(cause)}`),
  }).pipe(
    Effect.flatMap((init) =>
      init.claude_code_version !== undefined &&
      compareVersions(init.claude_code_version, minimumClaudeCodeVersion) < 0
        ? Effect.fail(
            unknownError(
              `Claude Code ${init.claude_code_version} is too old, clanka needs ${minimumClaudeCodeVersion} or later. Run \`claude update\`.`,
            ),
          )
        : Effect.void,
    ),
    Effect.onError(() => closeSession(live)),
  )
  return live
})

const toolResult = (part: Prompt.ToolResultPart): CallToolResult => ({
  content: [{ type: "text", text: render(part.result) }],
  isError: part.isFailure,
})

const isImageOnly = (message: Prompt.Message) =>
  message.role === "user" &&
  message.content.length > 0 &&
  message.content.every((part) => part.type === "file")

// How `prompt` continues the live session: the response of the last step,
// with the text and tool calls it emitted, then their results, then user
// messages.
// `undefined` when it does not, and the session has to start over with the
// full history.
const continuation = (
  session: Session,
  provider: LanguageModel.ProviderOptions,
) => {
  const outcome = session.outcome
  const messages = provider.prompt.content
  const seen = session.seen
  const response = messages[seen.length]
  if (
    outcome === undefined ||
    session.toolNames !== provider.tools.map((tool) => tool.name).join(",") ||
    response?.role !== "assistant"
  ) {
    return undefined
  }
  for (let i = 0; i < seen.length; i++) {
    if (messages[i] !== seen[i]) return undefined
  }
  const emitted = outcome.calls
  const calls = response.content.flatMap((part) =>
    part.type === "tool-call" && !part.providerExecuted ? [part] : [],
  )
  const text = response.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
  if (
    text !== outcome.text ||
    calls.length !== emitted.length ||
    !emitted.every(
      (call, i) =>
        calls[i]!.id === call.id &&
        calls[i]!.name === call.name &&
        isDeepStrictEqual(calls[i]!.params, call.params),
    )
  ) {
    return undefined
  }
  let rest = messages.slice(seen.length + 1)
  const results = new Map<string, Prompt.ToolResultPart>()
  while (rest[0]?.role === "tool") {
    for (const part of rest[0].content) {
      if (part.type === "tool-result") results.set(part.id, part)
    }
    rest = rest.slice(1)
  }
  const ids = emitted.map((call) => call.id)
  if (
    results.size !== ids.length ||
    !ids.every((id) => results.has(id)) ||
    !rest.every((message) => message.role === "user") ||
    (outcome._tag === "Stop" && rest.length === 0)
  ) {
    return undefined
  }
  return { ids, results, users: rest }
}

const continueSession = (
  session: Session,
  plan: NonNullable<ReturnType<typeof continuation>>,
) => {
  let users = plan.users
  const results = plan.ids.map((id) => toolResult(plan.results.get(id)!))
  // Images from the tool calls follow their results; they go back with the
  // last result.
  const last = results.at(-1)
  const images =
    last === undefined ? 0 : users.findIndex((message) => !isImageOnly(message))
  const attached = images === -1 ? users.length : images
  for (const block of toUserContent(
    Prompt.fromMessages(users.slice(0, attached)),
  )) {
    if (block.type === "image") {
      last?.content.push({
        type: "image",
        data: block.source.data,
        mimeType: block.source.media_type,
      })
    }
  }
  users = users.slice(attached)
  if (users.length > 0) {
    session.input.push(
      userMessage(
        toUserContent(Prompt.fromMessages(users)),
        results.length > 0 ? "next" : undefined,
      ),
    )
  }
  plan.ids.forEach((id, i) => session.bridge.resolve(id, results[i]!))
}

// The ids of the tool results in an SDK user message.
const toolResultIds = (message: Sdk.SDKUserMessage): Array<string> =>
  typeof message.message.content === "string"
    ? []
    : message.message.content.flatMap((block) =>
        block.type === "tool_result" ? [block.tool_use_id] : [],
      )

// Reads one step from the session, recording how it ended. A step that does
// not finish leaves the session in an unknown state, so it is closed.
//
// A tool step holds back its tool calls and its finish until Claude Code has
// parked an MCP request for every call. Effect runs a call's handler as soon
// as more parts follow it, so emitting a call earlier could run a script
// that Claude Code never waits for. An untagged request, or Claude Code
// answering a call itself, fails the step before any script runs.
const readStep = (
  session: Session,
  onAbandon: Effect.Effect<void>,
): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> =>
  Stream.suspend(() => {
    const convert = makeConverter()
    const calls: Array<Response.ToolCallPartEncoded> = []
    const parked = new Set<string>()
    let finish: Response.FinishPartEncoded | undefined
    let text = ""

    // Once the tool message's `message_stop` is read, every call it made is
    // known, so a park for any other id can never be released.
    const release = (): Effect.Effect<
      Array<Response.StreamPartEncoded>,
      AiError.AiError
    > => {
      if (finish === undefined) return Effect.succeed([])
      const unknown = [...parked].find(
        (id) => !calls.some((call) => call.id === id),
      )
      if (unknown !== undefined) {
        return Effect.fail(
          unknownError(
            `Claude Code called clanka for tool call ${unknown}, which it never made.`,
          ),
        )
      }
      if (!calls.every((call) => parked.has(call.id))) return Effect.succeed([])
      session.outcome = { _tag: "Tools", calls, text }
      return Effect.succeed([...calls, finish])
    }

    const handle = (
      event: SessionEvent,
    ): Effect.Effect<Array<Response.StreamPartEncoded>, AiError.AiError> => {
      if (event.type === "clanka_parked") {
        if (event.id === undefined) {
          return Effect.fail(
            unknownError(
              "Claude Code sent a tool call without its tool use id. This Claude Code version is not supported.",
            ),
          )
        }
        parked.add(event.id)
        return release()
      }
      if (event.type === "user" && event.parent_tool_use_id === null) {
        const answered = toolResultIds(event).find(
          (id) => !parked.has(id) && calls.some((call) => call.id === id),
        )
        if (answered !== undefined) {
          return Effect.fail(
            unknownError(
              `Claude Code answered the tool call ${answered} itself instead of calling clanka.`,
            ),
          )
        }
      }
      return Effect.flatMap(convert(event), (parts) => {
        const out: Array<Response.StreamPartEncoded> = []
        for (const part of parts) {
          if (part.type === "tool-call") {
            calls.push(part)
          } else if (part.type === "finish" && part.reason === "tool-calls") {
            finish = part
          } else {
            if (part.type === "text-delta") text += part.delta
            if (part.type === "finish") {
              session.outcome = { _tag: "Stop", calls: [], text }
            }
            out.push(part)
          }
        }
        return Effect.map(release(), (released) => [...out, ...released])
      })
    }

    return Stream.fromEffectRepeat(
      Queue.take(session.messages).pipe(
        Effect.catchIf(Cause.isDone, () =>
          Effect.fail(
            unknownError("Claude Code stopped before finishing its reply"),
          ),
        ),
      ),
    ).pipe(
      Stream.mapEffect(handle),
      Stream.flattenIterable,
      Stream.takeUntil((part) => part.type === "finish"),
      Stream.onExit(() =>
        session.outcome === undefined ? onAbandon : Effect.void,
      ),
    )
  })

// A call without tools, such as a compaction summary, runs on its own
// short-lived Claude Code.
const oneShot = (
  model: string,
  options: ModelOptions | undefined,
  provider: LanguageModel.ProviderOptions,
) =>
  Stream.unwrap(
    Effect.map(
      Effect.acquireRelease(
        startSession(model, options, provider, false),
        closeSession,
      ),
      (session) => readStep(session, Effect.void),
    ),
  ).pipe(Stream.scoped)

const layerLanguageModel = (
  model: string,
  options: ModelOptions | undefined,
): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.effect(
    LanguageModel.LanguageModel,
    Effect.gen(function* () {
      // The live session of the conversation, one per model layer.
      let current: Session | undefined
      const closeCurrent = Effect.suspend(() => {
        const session = current
        current = undefined
        return session === undefined ? Effect.void : closeSession(session)
      })
      yield* Effect.addFinalizer(() => closeCurrent)

      const step = (provider: LanguageModel.ProviderOptions) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const plan =
              current === undefined
                ? undefined
                : continuation(current, provider)
            if (current !== undefined && plan !== undefined) {
              continueSession(current, plan)
              current.seen = provider.prompt.content
              current.outcome = undefined
              return readStep(current, closeCurrent)
            }
            yield* closeCurrent
            current = yield* startSession(model, options, provider, true)
            return readStep(current, closeCurrent)
          }),
        )

      const streamText = (provider: LanguageModel.ProviderOptions) =>
        provider.tools.length === 0
          ? oneShot(model, options, provider)
          : step(provider)

      return yield* LanguageModel.make({
        streamText,
        generateText: (provider) =>
          streamText(provider).pipe(Stream.runCollect, Effect.map(toParts)),
      })
    }),
  )

// Stream parts as the parts of a whole response.
const toParts = (
  parts: ReadonlyArray<Response.StreamPartEncoded>,
): Array<Response.PartEncoded> => {
  const result: Array<Response.PartEncoded> = []
  const texts = new Map<string, { type: "text" | "reasoning"; text: string }>()
  for (const part of parts) {
    switch (part.type) {
      case "text-start":
      case "reasoning-start":
        texts.set(part.id, {
          type: part.type === "text-start" ? "text" : "reasoning",
          text: "",
        })
        break
      case "text-delta":
      case "reasoning-delta": {
        const text = texts.get(part.id)
        if (text !== undefined) text.text += part.delta
        break
      }
      case "text-end":
      case "reasoning-end": {
        const text = texts.get(part.id)
        if (text !== undefined)
          result.push({ type: text.type, text: text.text })
        break
      }
      case "tool-call":
      case "finish":
        result.push(part)
        break
    }
  }
  return result
}

/**
 * A Claude model run by the user's installed Claude Code, with whatever
 * login it has: a Claude subscription, an API key, or Bedrock, Vertex or
 * Foundry credentials.
 *
 * @since 1.0.0
 * @category Layers
 */
export const model = (
  model: string,
  options?: ModelOptions | undefined,
): Model.Model<"claude", LanguageModel.LanguageModel, never> =>
  Model.make(
    "claude",
    model,
    Layer.merge(
      layerLanguageModel(model, options),
      // The system prompt stays in the Prompt, where `queryOptions` reads
      // it. No Compaction.SummarizerTransform: Claude Code takes no
      // per-request output cap.
      AgentModelConfig.layer({ supportsImages: options?.supportsImages }),
    ),
  )

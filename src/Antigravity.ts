/**
 * The `antigravity` provider: the Gemini, Claude and GPT-OSS models of a
 * Google Antigravity subscription, through the Cloud Code API the
 * Antigravity app uses.
 *
 * @since 1.0.0
 */
/** @effect-diagnostics schemaNumber:off */
import * as AiError from "effect/ai/AiError"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import type * as Prompt from "effect/ai/Prompt"
import type * as Response from "effect/ai/Response"
import * as Tool from "effect/ai/Tool"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Struct from "effect/Struct"
import { AgentModelConfig } from "./Agent.ts"
import * as Compaction from "./Compaction.ts"
import {
  AntigravityAuth,
  type AntigravityAuthError,
  API_URL,
  USER_AGENT,
} from "./AntigravityAuth.ts"

// Accepted by Cloud Code in place of a thought signature, for tool calls made
// by another provider or model family.
const SKIP_SIGNATURE = "skip_thought_signature_validator"

interface Part {
  readonly text?: string
  readonly thought?: boolean
  readonly thoughtSignature?: string
  readonly inlineData?: { readonly mimeType: string; readonly data: string }
  readonly fileData?: { readonly mimeType: string; readonly fileUri: string }
  readonly functionCall?: {
    readonly id: string
    readonly name: string
    readonly args: unknown
  }
  readonly functionResponse?: {
    readonly id: string
    readonly name: string
    readonly response: { readonly result: string }
  }
}

interface Content {
  readonly role: "user" | "model"
  readonly parts: Array<Part>
}

/**
 * A Gemini `generateContent` request, as Cloud Code takes it.
 *
 * @since 1.0.0
 * @category Models
 */
export interface GenerateContentRequest {
  readonly contents: ReadonlyArray<Content>
  readonly systemInstruction?: { readonly parts: ReadonlyArray<Part> }
  readonly tools?: ReadonlyArray<unknown>
  readonly toolConfig?: unknown
  readonly generationConfig?: Record<string, unknown>
}

const ResponsePart = Schema.Struct({
  text: Schema.optional(Schema.String),
  thought: Schema.optional(Schema.Boolean),
  thoughtSignature: Schema.optional(Schema.String),
  functionCall: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      name: Schema.String,
      args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
})

/**
 * One event of a `streamGenerateContent` response.
 *
 * @since 1.0.0
 * @category Models
 */
export const GenerateContentChunk = Schema.Struct({
  response: Schema.Struct({
    candidates: Schema.optional(
      Schema.Array(
        Schema.Struct({
          content: Schema.optional(
            Schema.Struct({
              parts: Schema.optional(Schema.Array(ResponsePart)),
            }),
          ),
          finishReason: Schema.optional(Schema.String),
        }),
      ),
    ),
    usageMetadata: Schema.optional(
      Schema.Struct({
        promptTokenCount: Schema.optional(Schema.Number),
        candidatesTokenCount: Schema.optional(Schema.Number),
        thoughtsTokenCount: Schema.optional(Schema.Number),
        cachedContentTokenCount: Schema.optional(Schema.Number),
      }),
    ),
    responseId: Schema.optional(Schema.String),
    modelVersion: Schema.optional(Schema.String),
  }),
})

/**
 * @since 1.0.0
 * @category Models
 */
export type GenerateContentChunk = typeof GenerateContentChunk.Type

const decodeChunk = Schema.decodeUnknownEffect(GenerateContentChunk)

const invalidOutput = (description: string) =>
  aiError(
    "streamGenerateContent",
    new AiError.InvalidOutputError({ description }),
  )

// Cloud Code sends one JSON document per `data:` line, but can end the
// stream without the blank line that ends an SSE event, and reports a
// failure after the response started as bare, multi-line JSON. Lines are
// joined until they parse.
const jsonPayloads = <E, R>(lines: Stream.Stream<string, E, R>) =>
  Stream.suspend(() => {
    let pending = ""
    return lines.pipe(
      Stream.map((line): Array<unknown> => {
        const text = line.trim().replace(/^data:\s*/, "")
        if (pending === "" && !text.startsWith("{")) return []
        pending = pending === "" ? text : `${pending}\n${text}`
        try {
          const payload: unknown = JSON.parse(pending)
          pending = ""
          return [payload]
        } catch {
          return []
        }
      }),
      Stream.flattenIterable,
      Stream.concat(
        Stream.suspend(() =>
          pending === ""
            ? Stream.empty
            : Stream.fail(invalidOutput("The response ended mid-event")),
        ),
      ),
    )
  })

const BackendError = Schema.Struct({
  error: Schema.Struct({
    code: Schema.optional(Schema.Number),
    message: Schema.optional(Schema.String),
  }),
})
const isBackendError = Schema.is(BackendError)

const toChunk = (payload: unknown) => {
  if (isBackendError(payload)) {
    const code = payload.error.code ?? 0
    return Effect.fail(
      aiError(
        "streamGenerateContent",
        AiError.reasonFromHttpStatus({
          status: code >= 400 && code <= 599 ? code : 502,
          description: payload.error.message,
        }),
      ),
    )
  }
  return decodeChunk(payload).pipe(
    Effect.mapError((error) => invalidOutput(error.message)),
  )
}

const aiError = (method: string, reason: AiError.AiErrorReason) =>
  AiError.make({ module: "Antigravity", method, reason })

const httpError = (error: HttpClientError.HttpClientError) =>
  aiError(
    "streamGenerateContent",
    error.reason._tag === "TransportError" ||
      error.reason._tag === "EncodeError" ||
      error.reason._tag === "InvalidUrlError"
      ? AiError.NetworkError.fromHttpClientError(
          error as HttpClientError.HttpClientError & {
            readonly reason: HttpClientError.RequestError
          },
        )
      : new AiError.InternalProviderError({ description: error.message }),
  )

const authError = (error: AntigravityAuthError) =>
  aiError(
    "streamGenerateContent",
    new AiError.AuthenticationError({
      kind: "Unknown",
      description: error.message,
    }),
  )

/**
 * Sends Gemini requests to Cloud Code as the signed-in Antigravity account.
 *
 * @since 1.0.0
 * @category Services
 */
export class AntigravityClient extends Context.Service<
  AntigravityClient,
  {
    readonly streamGenerateContent: (options: {
      readonly model: string
      readonly request: GenerateContentRequest
    }) => Stream.Stream<GenerateContentChunk, AiError.AiError>
  }
>()("clanka/Antigravity/AntigravityClient") {
  static readonly make = Effect.gen(function* () {
    const auth = yield* AntigravityAuth
    const httpClient = yield* HttpClient.HttpClient
    // The Antigravity app sends a session id with every request of a
    // conversation; one per client is close enough for prompt caching.
    const sessionId = `-${crypto.getRandomValues(new BigUint64Array(1))[0]! >> 1n}`
    return AntigravityClient.of({
      streamGenerateContent: ({ model, request }) =>
        Effect.gen(function* () {
          const token = yield* Effect.mapError(auth.get, authError)
          const response = yield* HttpClientRequest.post(
            `${API_URL}:streamGenerateContent?alt=sse`,
          ).pipe(
            HttpClientRequest.bearerToken(token.access),
            HttpClientRequest.setHeader("User-Agent", USER_AGENT),
            HttpClientRequest.bodyJsonUnsafe({
              project: token.project,
              model,
              userAgent: "antigravity",
              requestType: "agent",
              requestId: `agent-${crypto.randomUUID()}`,
              request: { ...request, sessionId },
            }),
            httpClient.execute,
            Effect.mapError(httpError),
          )
          if (response.status !== 200) {
            const body = yield* response.text.pipe(
              Effect.orElseSucceed(() => ""),
            )
            return yield* aiError(
              "streamGenerateContent",
              AiError.reasonFromHttpStatus({
                status: response.status,
                description: body,
              }),
            )
          }
          return response.stream.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.mapError(httpError),
            jsonPayloads,
            Stream.mapEffect(toChunk),
          )
        }).pipe(Stream.unwrap),
    })
  })

  /**
   * Signs in on first use, through `OAuthCallback`, and keeps the tokens in
   * the `KeyValueStore`.
   */
  static readonly layer = Layer.effect(
    AntigravityClient,
    AntigravityClient.make,
  ).pipe(Layer.provide(AntigravityAuth.layer))
}

/**
 * @since 1.0.0
 * @category Layers
 */
export const layerClient = AntigravityClient.layer

/**
 * Caps the output tokens of the Claude requests made within it, thinking
 * included. Other models are sent no cap, as the Antigravity app does.
 *
 * @since 1.0.0
 * @category Configuration
 */
export class MaxOutputTokens extends Context.Reference<number | undefined>(
  "clanka/Antigravity/MaxOutputTokens",
  { defaultValue: () => undefined },
) {}

/**
 * Options for a model. `reasoning: null` turns thinking off; omitting
 * `reasoning` or its effort keeps the model's default thinking level.
 *
 * @since 1.0.0
 * @category Models
 */
export type ModelOptions = {
  readonly reasoning?:
    { readonly effort?: string | undefined } | null | undefined
} & typeof AgentModelConfig.Service

/**
 * @since 1.0.0
 * @category Layers
 */
export const model = (
  model: string,
  options?: ModelOptions | undefined,
): Model.Model<"antigravity", LanguageModel.LanguageModel, AntigravityClient> =>
  Model.make(
    "antigravity",
    model,
    Layer.mergeAll(
      Layer.effect(
        LanguageModel.LanguageModel,
        make(model, options?.reasoning),
      ),
      AgentModelConfig.layer(
        Struct.pick(options ?? {}, AgentModelConfig.optionKeys),
      ),
      Layer.succeed(Compaction.SummarizerTransform, (effect) =>
        Effect.provideService(
          effect,
          MaxOutputTokens,
          Compaction.summarizerMaxOutputTokens,
        ),
      ),
    ),
  )

const make = Effect.fnUntraced(function* (
  model: string,
  reasoning: ModelOptions["reasoning"],
) {
  const client = yield* AntigravityClient
  const streamText = (options: LanguageModel.ProviderOptions) =>
    Effect.gen(function* () {
      const maxOutputTokens = yield* MaxOutputTokens
      const parts = streamParts(model)
      return client
        .streamGenerateContent({
          model,
          request: toRequest(model, reasoning, maxOutputTokens, options),
        })
        .pipe(
          Stream.map(parts.chunk),
          Stream.concat(Stream.sync(parts.end)),
          Stream.flattenIterable,
        )
    }).pipe(Stream.unwrap)
  return yield* LanguageModel.make({
    streamText,
    generateText: (options) =>
      streamText(options).pipe(Stream.runCollect, Effect.map(collect)),
  })
})

// Claude 4 models take a thinking budget; the others a thinking level.
const budgets: Record<string, number> = {
  minimal: 1024,
  low: 4096,
  medium: 16384,
  high: 32768,
  xhigh: 48000,
  max: 63999,
}

// A thinking budget must stay below the output cap. Like CLIProxyAPI, only
// Claude requests carry a cap.
const generationConfig = (
  model: string,
  reasoning: ModelOptions["reasoning"],
  claudeMaxOutputTokens: number | undefined,
): Record<string, unknown> => {
  const maxOutputTokens = model.startsWith("claude-")
    ? claudeMaxOutputTokens
    : undefined
  const cap = maxOutputTokens === undefined ? {} : { maxOutputTokens }
  if (reasoning === null || reasoning?.effort === "none") return cap
  const effort = reasoning?.effort
  if (effort === undefined) {
    return { ...cap, thinkingConfig: { includeThoughts: true } }
  }
  if (/^claude-.*-4-/.test(model)) {
    const budget = budgets[effort] ?? budgets.medium!
    return {
      maxOutputTokens: maxOutputTokens ?? 64000,
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget:
          maxOutputTokens === undefined
            ? budget
            : Math.min(budget, Math.floor(maxOutputTokens / 2)),
      },
    }
  }
  return {
    ...cap,
    thinkingConfig: {
      includeThoughts: true,
      thinkingLevel: effort === "xhigh" || effort === "max" ? "high" : effort,
    },
  }
}

const toRequest = (
  model: string,
  reasoning: ModelOptions["reasoning"],
  maxOutputTokens: number | undefined,
  options: LanguageModel.ProviderOptions,
): GenerateContentRequest => {
  const { system, contents } = toContents(options.prompt, model)
  const declarations = options.tools
    .filter((tool) => !Tool.isProviderDefined(tool))
    .map((tool) => ({
      name: tool.name,
      description: Tool.getDescription(tool),
      parameters: toGeminiSchema(Tool.getJsonSchema(tool)),
    }))
  return {
    contents,
    ...(system.length > 0
      ? { systemInstruction: { parts: [{ text: system.join("\n\n") }] } }
      : undefined),
    ...(declarations.length > 0
      ? {
          tools: [{ functionDeclarations: declarations }],
          toolConfig: {
            functionCallingConfig: functionCalling(
              options.toolChoice,
              model.startsWith("claude-"),
            ),
          },
        }
      : undefined),
    generationConfig: generationConfig(model, reasoning, maxOutputTokens),
  }
}

const functionCalling = (
  choice: LanguageModel.ToolChoice<any>,
  claude: boolean,
) => {
  if (choice === "none") return { mode: "NONE" }
  if (choice === "required") return { mode: "ANY" }
  if (choice === "auto") return { mode: claude ? "VALIDATED" : "AUTO" }
  if ("tool" in choice) {
    return { mode: "ANY", allowedFunctionNames: [choice.tool] }
  }
  return {
    mode: choice.mode === "required" ? "ANY" : "AUTO",
    allowedFunctionNames: choice.oneOf,
  }
}

// Signatures are only valid for models of the family that issued them.
const family = (model: string) =>
  ["claude", "gpt", "gemini"].find((family) => model.includes(family)) ?? model

const signature = (
  options: Prompt.ProviderOptions,
  model: string,
): string | undefined => {
  const value = options.antigravity
  return Predicate.isObject(value) &&
    Predicate.isString(value.thoughtSignature) &&
    Predicate.isString(value.model) &&
    family(value.model) === family(model)
    ? value.thoughtSignature
    : undefined
}

const filePart = (part: Prompt.FilePart): Part => {
  const mimeType = part.mediaType === "image/*" ? "image/jpeg" : part.mediaType
  if (part.data instanceof URL) {
    return { fileData: { mimeType, fileUri: part.data.toString() } }
  }
  if (part.data instanceof Uint8Array) {
    return { inlineData: { mimeType, data: Base64.encode(part.data) } }
  }
  const dataUrl = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(part.data)
  return dataUrl === null
    ? { inlineData: { mimeType, data: part.data } }
    : { inlineData: { mimeType: dataUrl[1] ?? mimeType, data: dataUrl[2]! } }
}

const assistantParts = (
  part: Prompt.AssistantMessagePart,
  model: string,
): Array<Part> => {
  const thoughtSignature = signature(part.options, model)
  switch (part.type) {
    case "text":
      return part.text === "" && thoughtSignature === undefined
        ? []
        : [{ text: part.text, ...(thoughtSignature && { thoughtSignature }) }]
    case "reasoning":
      // Thoughts are replayed only with the signature that vouches for them.
      return thoughtSignature === undefined
        ? []
        : [{ text: part.text, thought: true, thoughtSignature }]
    case "tool-call":
      return part.providerExecuted
        ? []
        : [
            {
              functionCall: { id: part.id, name: part.name, args: part.params },
              ...(thoughtSignature && { thoughtSignature }),
            },
          ]
    default:
      return []
  }
}

const toolOutput = (part: Prompt.ToolResultPart) =>
  part.modelOutput !== undefined
    ? part.modelOutput
        .map((output) => (output.type === "text" ? output.text : ""))
        .join("")
    : typeof part.result === "string"
      ? part.result
      : JSON.stringify(part.result)

// Leading system messages become the system instruction; later ones are
// sent as user text, where they were. Consecutive messages of one role are
// merged, as Gemini expects turns to alternate.
const toContents = (prompt: Prompt.Prompt, model: string) => {
  const system: Array<string> = []
  const contents: Array<Content> = []
  const push = (role: Content["role"], parts: Array<Part>) => {
    if (parts.length === 0) return
    const last = contents.at(-1)
    if (last?.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }
  for (const message of prompt.content) {
    switch (message.role) {
      case "system":
        if (contents.length === 0) system.push(message.content)
        else push("user", [{ text: message.content }])
        break
      case "user":
        push(
          "user",
          message.content.map((part) =>
            part.type === "text" ? { text: part.text } : filePart(part),
          ),
        )
        break
      case "assistant":
        push(
          "model",
          message.content.flatMap((part) => assistantParts(part, model)),
        )
        break
      case "tool":
        push(
          "user",
          message.content.flatMap((part) =>
            part.type === "tool-result"
              ? [
                  {
                    functionResponse: {
                      id: part.id,
                      name: part.name,
                      response: { result: toolOutput(part) },
                    },
                  },
                ]
              : [],
          ),
        )
        break
    }
  }
  // Cloud Code checks the signature of the first tool call of a turn only.
  // Parallel calls after it stay unsigned, as the model sent them.
  for (const content of contents) {
    if (content.role !== "model") continue
    const index = content.parts.findIndex((part) => part.functionCall)
    const first = content.parts[index]
    if (first !== undefined && first.thoughtSignature === undefined) {
      content.parts[index] = { ...first, thoughtSignature: SKIP_SIGNATURE }
    }
  }
  return { system, contents }
}

// Cloud Code takes the OpenAPI subset of JSON Schema Gemini supports. Local
// `$ref`s are inlined and unsupported keywords dropped.
const toGeminiSchema = (
  schema: unknown,
  defs: Record<string, unknown> = Predicate.isObject(schema) &&
  "$defs" in schema &&
  Predicate.isObject(schema.$defs)
    ? (schema.$defs as Record<string, unknown>)
    : {},
): unknown => {
  if (!Predicate.isObject(schema)) return schema
  const source = schema as Record<string, unknown>
  if (Predicate.isString(source.$ref)) {
    return toGeminiSchema(defs[source.$ref.replace(/^#\/\$defs\//, "")], defs)
  }
  const out: Record<string, unknown> = {}
  if (Array.isArray(source.type)) {
    out.type = source.type.find((type) => type !== "null")
    if (source.type.includes("null")) out.nullable = true
  } else if (source.type !== undefined) {
    out.type = source.type
  }
  for (const key of ["description", "required", "nullable"] as const) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  if (Array.isArray(source.enum) && source.enum.every(Predicate.isString)) {
    out.enum = source.enum
  }
  if (Predicate.isObject(source.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(source.properties).map(([key, value]) => [
        key,
        toGeminiSchema(value, defs),
      ]),
    )
  }
  if (source.items !== undefined) out.items = toGeminiSchema(source.items, defs)
  const union = source.anyOf ?? source.oneOf
  if (Array.isArray(union)) {
    out.anyOf = union.map((branch) => toGeminiSchema(branch, defs))
  }
  return out
}

const finishReason = (
  reason: string | undefined,
  hasToolCalls: boolean,
): Response.FinishReason => {
  switch (reason) {
    // Tool call turns can end without a finish reason.
    case undefined:
      return hasToolCalls ? "tool-calls" : "unknown"
    case "STOP":
      return hasToolCalls ? "tool-calls" : "stop"
    case "MAX_TOKENS":
      return "length"
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "content-filter"
    case "MALFORMED_FUNCTION_CALL":
      return "error"
    default:
      return "other"
  }
}

// Turns response chunks into stream parts. A thought signature belongs to
// the text or thoughts it arrives with or after, or to its tool call.
const streamParts = (model: string) => {
  let block:
    { type: "text" | "reasoning"; id: string; signature?: string } | undefined
  let blocks = 0
  let calls = 0
  let responseId: string | undefined
  let reason: string | undefined
  let hasToolCalls = false
  let usage: GenerateContentChunk["response"]["usageMetadata"]
  const close = (out: Array<Response.StreamPartEncoded>) => {
    if (block === undefined) return
    out.push({
      type: `${block.type}-end`,
      id: block.id,
      ...(block.signature && {
        metadata: {
          antigravity: { thoughtSignature: block.signature, model },
        },
      }),
    })
    block = undefined
  }
  const open = (
    type: "text" | "reasoning",
    out: Array<Response.StreamPartEncoded>,
  ) => {
    if (block?.type === type) return block
    close(out)
    block = { type, id: String(blocks++) }
    out.push({ type: `${type}-start`, id: block.id })
    return block
  }
  return {
    chunk: ({ response }: GenerateContentChunk) => {
      const out: Array<Response.StreamPartEncoded> = []
      if (responseId === undefined) {
        responseId = response.responseId ?? crypto.randomUUID()
        out.push({
          type: "response-metadata",
          id: responseId,
          modelId: response.modelVersion,
        })
      }
      usage = response.usageMetadata ?? usage
      const candidate = response.candidates?.[0]
      reason = candidate?.finishReason ?? reason
      for (const part of candidate?.content?.parts ?? []) {
        if (part.functionCall !== undefined) {
          close(out)
          hasToolCalls = true
          out.push({
            type: "tool-call",
            id: part.functionCall.id ?? `${responseId}-${calls++}`,
            name: part.functionCall.name,
            params: part.functionCall.args ?? {},
            ...(part.thoughtSignature && {
              metadata: {
                antigravity: { thoughtSignature: part.thoughtSignature, model },
              },
            }),
          })
          continue
        }
        const type = part.thought ? "reasoning" : "text"
        if (part.text) {
          const current = open(type, out)
          out.push({ type: `${type}-delta`, id: current.id, delta: part.text })
        }
        if (part.thoughtSignature) {
          ;(block ?? open(type, out)).signature = part.thoughtSignature
        }
      }
      return out
    },
    end: () => {
      const out: Array<Response.StreamPartEncoded> = []
      close(out)
      const prompt = usage?.promptTokenCount
      const cached = usage?.cachedContentTokenCount
      const text = usage?.candidatesTokenCount
      const thoughts = usage?.thoughtsTokenCount
      out.push({
        type: "finish",
        reason: finishReason(reason, hasToolCalls),
        usage: {
          inputTokens: {
            total: prompt,
            cacheRead: cached,
            uncached: prompt === undefined ? undefined : prompt - (cached ?? 0),
          },
          outputTokens: {
            total:
              text === undefined && thoughts === undefined
                ? undefined
                : (text ?? 0) + (thoughts ?? 0),
            text,
            reasoning: thoughts,
          },
        },
      })
      return out
    },
  }
}

// The non-streaming parts of a stream, for `generateText`.
const collect = (
  parts: ReadonlyArray<Response.StreamPartEncoded>,
): Array<Response.PartEncoded> => {
  const out: Array<Response.PartEncoded> = []
  let text = ""
  for (const part of parts) {
    switch (part.type) {
      case "text-delta":
      case "reasoning-delta":
        text += part.delta
        break
      case "text-end":
      case "reasoning-end":
        out.push({
          type: part.type === "text-end" ? "text" : "reasoning",
          text,
          ...(part.metadata?.antigravity && {
            metadata: { antigravity: part.metadata.antigravity },
          }),
        })
        text = ""
        break
      case "response-metadata":
      case "tool-call":
      case "finish":
        out.push(part)
        break
    }
  }
  return out
}

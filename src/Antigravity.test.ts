import { createHash } from "node:crypto"
import { assert, describe, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Prompt from "effect/ai/Prompt"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import {
  HttpClient,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Antigravity from "./Antigravity.ts"
import { AntigravityAuth, TokenData, toTokenStore } from "./AntigravityAuth.ts"
import { AuthCodeHandler } from "./AuthCodeHandler.ts"
import * as Compaction from "./Compaction.ts"

const sse = (events: ReadonlyArray<unknown>) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")

const sseEvent = (
  parts: ReadonlyArray<unknown>,
  options?: {
    readonly finishReason?: string
    readonly usageMetadata?: Record<string, number>
  },
) => ({
  response: {
    candidates: [
      {
        content: { parts },
        ...(options?.finishReason && { finishReason: options.finishReason }),
      },
    ],
    ...(options?.usageMetadata && { usageMetadata: options.usageMetadata }),
  },
})

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const bodyText = (request: HttpClientRequest.HttpClientRequest) => {
  if (request.body._tag !== "Uint8Array") throw new Error("Expected a body")
  return new TextDecoder().decode(request.body.body)
}

const noSignIn: AuthCodeHandler["Service"] = {
  request: () => Effect.die("Must not sign in"),
}

const seedToken = (
  overrides?: Partial<ConstructorParameters<typeof TokenData>[0]>,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      yield* toTokenStore(yield* KeyValueStore.KeyValueStore)
        .set(
          "token",
          new TokenData({
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 3600_000,
            project: "project-1",
            ...overrides,
          }),
        )
        .pipe(Effect.orDie)
    }),
  )

const captureHttp = (
  respond: (request: HttpClientRequest.HttpClientRequest) => Response,
) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request)
        return HttpClientResponse.fromWeb(request, respond(request))
      }),
    ),
  )
  const json = (index = 0): Record<string, any> =>
    JSON.parse(bodyText(requests[index]!))
  const endpoints = () =>
    requests.map((request) => request.url.split("/").at(-1))
  return { requests, layer, json, endpoints }
}

const Tools = Toolkit.make(
  Tool.make("execute", {
    description: "Run a script.",
    parameters: Schema.Struct({
      script: Schema.String.check(Schema.isMinLength(1)),
    }),
    success: Schema.String,
  }),
)
const ToolsLive = Tools.toLayer({ execute: () => Effect.die("not called") })

const setupModel = (response: () => Response) => {
  const http = captureHttp(response)
  const layer = (model: string, options?: Antigravity.ModelOptions) =>
    Layer.merge(
      Antigravity.model(model, options).pipe(
        Layer.provide(Antigravity.layerClient),
        Layer.provide([http.layer, Layer.succeed(AuthCodeHandler, noSignIn)]),
        Layer.provide(seedToken()),
        Layer.provide(KeyValueStore.layerMemory),
      ),
      ToolsLive,
    )
  return { ...http, layer }
}

const signIn = (code = "auth-code") => {
  const urls: Array<URL> = []
  const handler: AuthCodeHandler["Service"] = {
    request: ({ url }) =>
      Effect.sync(() => {
        urls.push(new URL(url))
        return code
      }),
  }
  return { urls, handler }
}

const setupAuth = (
  handler: AuthCodeHandler["Service"],
  options: {
    readonly loadCodeAssist?: unknown
    readonly tokenErrors?: ReadonlyArray<unknown>
    readonly env?: Record<string, string>
  } = {},
) => {
  const tokenErrors = [...(options.tokenErrors ?? [])]
  const http = captureHttp((request) => {
    if (request.url === "https://oauth2.googleapis.com/token") {
      const error = tokenErrors.shift()
      return error !== undefined
        ? jsonResponse(error, 401)
        : jsonResponse({
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 3600,
          })
    }
    if (request.url.endsWith(":loadCodeAssist")) {
      return jsonResponse(
        options.loadCodeAssist ?? {
          allowedTiers: [
            { id: "legacy-tier" },
            { id: "free-tier", isDefault: true },
          ],
        },
      )
    }
    return jsonResponse({
      done: true,
      response: { cloudaicompanionProject: { id: "onboarded-project" } },
    })
  })
  const layer = AntigravityAuth.layer.pipe(
    Layer.provide([http.layer, Layer.succeed(AuthCodeHandler, handler)]),
    Layer.provide(
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: options.env ?? {} })),
    ),
  )
  return { ...http, layer }
}

describe("Antigravity provider", () => {
  it.effect(
    "sends a conversation to Cloud Code and streams back thoughts, text and tool calls",
    () =>
      Effect.gen(function* () {
        const http = setupModel(
          () =>
            new Response(
              sse([
                sseEvent([
                  { text: "Listing files.", thought: true },
                  { text: "", thought: true, thoughtSignature: "sig-1" },
                ]),
                sseEvent([{ text: "Running ls." }]),
                sseEvent(
                  [
                    {
                      functionCall: {
                        id: "call-2",
                        name: "execute",
                        args: { script: "ls" },
                      },
                    },
                  ],
                  {
                    finishReason: "STOP",
                    usageMetadata: {
                      promptTokenCount: 100,
                      cachedContentTokenCount: 40,
                      candidatesTokenCount: 20,
                      thoughtsTokenCount: 5,
                    },
                  },
                ),
              ]),
              { headers: { "content-type": "text/event-stream" } },
            ),
        )
        const response = yield* LanguageModel.generateText({
          prompt: Prompt.make([
            { role: "system", content: "Be brief." },
            { role: "user", content: "List the files." },
            {
              role: "assistant",
              content: [
                Prompt.makePart("tool-call", {
                  id: "call-1",
                  name: "execute",
                  params: { script: "pwd" },
                  providerExecuted: false,
                }),
              ],
            },
            {
              role: "tool",
              content: [
                Prompt.makePart("tool-result", {
                  id: "call-1",
                  name: "execute",
                  isFailure: false,
                  result: "/repo",
                  providerExecuted: false,
                }),
              ],
            },
          ]),
          toolkit: Tools,
          disableToolCallResolution: true,
        }).pipe(
          Effect.provide(
            http.layer("gemini-3-flash", { reasoning: { effort: "low" } }),
          ),
        )

        const request = http.requests[0]!
        assert.strictEqual(
          request.url,
          "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        )
        assert.strictEqual(request.headers.authorization, "Bearer access-token")
        assert.match(request.headers["user-agent"]!, /^antigravity\//)
        const body = http.json()
        assert.strictEqual(body.project, "project-1")
        assert.strictEqual(body.model, "gemini-3-flash")
        assert.deepStrictEqual(body.request.systemInstruction, {
          parts: [{ text: "Be brief." }],
        })
        assert.deepStrictEqual(body.request.contents, [
          { role: "user", parts: [{ text: "List the files." }] },
          {
            role: "model",
            parts: [
              {
                functionCall: {
                  id: "call-1",
                  name: "execute",
                  args: { script: "pwd" },
                },
                thoughtSignature: "skip_thought_signature_validator",
              },
            ],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "call-1",
                  name: "execute",
                  response: { result: "/repo" },
                },
              },
            ],
          },
        ])
        assert.deepStrictEqual(body.request.tools, [
          {
            functionDeclarations: [
              {
                name: "execute",
                description: "Run a script.",
                parameters: {
                  type: "object",
                  required: ["script"],
                  properties: { script: { type: "string" } },
                },
              },
            ],
          },
        ])
        assert.deepStrictEqual(body.request.generationConfig, {
          thinkingConfig: { includeThoughts: true, thinkingLevel: "low" },
        })

        assert.strictEqual(response.reasoningText, "Listing files.")
        assert.strictEqual(response.text, "Running ls.")
        assert.deepStrictEqual(
          response.toolCalls.map(({ id, name, params }) => ({
            id,
            name,
            params,
          })),
          [{ id: "call-2", name: "execute", params: { script: "ls" } }],
        )
        assert.strictEqual(response.finishReason, "tool-calls")
        assert.deepStrictEqual(
          {
            input: response.usage.inputTokens,
            output: response.usage.outputTokens,
          },
          {
            input: { total: 100, cacheRead: 40, uncached: 60 },
            output: { total: 25, text: 20, reasoning: 5 },
          },
        )

        yield* LanguageModel.generateText({
          prompt: Prompt.fromResponseParts(response.content),
          toolkit: Tools,
          disableToolCallResolution: true,
        }).pipe(Effect.provide(http.layer("gemini-3-flash")))
        assert.deepStrictEqual(http.json(1).request.contents[0]?.parts[0], {
          text: "Listing files.",
          thought: true,
          thoughtSignature: "sig-1",
        })
      }),
  )

  it.effect(
    "replays a streamed turn with its signatures to the same model family only",
    () =>
      Effect.gen(function* () {
        // Gemini signs the first of parallel tool calls only.
        const http = setupModel(
          () =>
            new Response(
              sse([
                sseEvent([
                  { text: "Two calls.", thought: true },
                  { text: "", thought: true, thoughtSignature: "sig-1" },
                  {
                    functionCall: {
                      id: "a",
                      name: "execute",
                      args: { script: "ls" },
                    },
                    thoughtSignature: "sig-2",
                  },
                  {
                    functionCall: {
                      id: "b",
                      name: "execute",
                      args: { script: "pwd" },
                    },
                  },
                ]),
              ]),
            ),
        )
        const turn = (prompt: Prompt.RawInput, model: string) =>
          LanguageModel.streamText({
            prompt,
            toolkit: Tools,
            disableToolCallResolution: true,
          }).pipe(Stream.runCollect, Effect.provide(http.layer(model)))
        const parts = yield* turn("Run two scripts.", "gemini-3-flash")
        const history = Prompt.concat(
          Prompt.make("Run two scripts."),
          Prompt.fromResponseParts(parts),
        )
        yield* turn(history, "gemini-3.8-flash-high")
        yield* turn(history, "claude-sonnet-4-6")

        const calls = [
          {
            functionCall: { id: "a", name: "execute", args: { script: "ls" } },
          },
          {
            functionCall: { id: "b", name: "execute", args: { script: "pwd" } },
          },
        ]
        assert.deepStrictEqual(http.json(1).request.contents[1], {
          role: "model",
          parts: [
            { text: "Two calls.", thought: true, thoughtSignature: "sig-1" },
            { ...calls[0], thoughtSignature: "sig-2" },
            calls[1],
          ],
        })
        assert.deepStrictEqual(http.json(2).request.contents[1], {
          role: "model",
          parts: calls,
        })
      }),
  )

  it.effect("caps compaction summaries for Claude models only", () =>
    Effect.gen(function* () {
      const http = setupModel(() => new Response(sse([{ response: {} }])))
      const summarize = (model: string) =>
        Effect.gen(function* () {
          const summarize = yield* Compaction.SummarizerTransform
          yield* summarize(LanguageModel.generateText({ prompt: "Summarize" }))
        }).pipe(
          Effect.provide(http.layer(model, { reasoning: { effort: "high" } })),
        )
      yield* summarize("claude-opus-4-6-thinking")
      yield* summarize("gemini-3-flash")
      assert.deepStrictEqual(http.json(0).request.generationConfig, {
        maxOutputTokens: 4000,
        thinkingConfig: { includeThoughts: true, thinkingBudget: 2000 },
      })
      assert.deepStrictEqual(http.json(1).request.generationConfig, {
        thinkingConfig: { includeThoughts: true, thinkingLevel: "high" },
      })
    }),
  )

  // A captured Cloud Code stream: a tool call with usage, no finish reason,
  // and no blank line before the end of the stream.
  it.effect("finishes a tool call turn that ends without a finish reason", () =>
    Effect.gen(function* () {
      const http = setupModel(
        () =>
          new Response(
            `data: {"response":{"candidates":[{"content":{"parts":[{"thoughtSignature":"CqcECqQEARFNMg8iZ3xVniKaulgBlzhJJDlc","functionCall":{"name":"execute","args":{"script":"ls -la .."},"id":"call_524881"}}],"role":"model"}}],"modelVersion":"gemini-3.7-flash","responseId":"resp-nofr","usageMetadata":{"promptTokenCount":153609,"candidatesTokenCount":17,"totalTokenCount":153720,"thoughtsTokenCount":94}}}\n`,
          ),
      )
      const response = yield* LanguageModel.generateText({
        prompt: "Run ls",
        toolkit: Tools,
        disableToolCallResolution: true,
      }).pipe(Effect.provide(http.layer("gemini-3-flash")))
      assert.deepStrictEqual(
        response.toolCalls.map(({ id, params }) => ({ id, params })),
        [{ id: "call_524881", params: { script: "ls -la .." } }],
      )
      assert.strictEqual(response.finishReason, "tool-calls")
      assert.strictEqual(response.usage.inputTokens.total, 153609)
      assert.strictEqual(response.usage.outputTokens.total, 111)
    }),
  )

  it.effect("reports HTTP and trailing stream errors as retryable", () =>
    Effect.gen(function* () {
      for (const [response, tag] of [
        [
          () =>
            new Response(`data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}],"modelVersion":"gemini-3.7-flash"}}

{
  "error": {
    "code": 503,
    "message": "backend capacity exhausted",
    "status": "UNAVAILABLE"
  }
}
`),
          "InternalProviderError",
        ],
        [
          () => new Response("Resource has been exhausted", { status: 429 }),
          "RateLimitError",
        ],
      ] as const) {
        const error = yield* LanguageModel.generateText({ prompt: "Hi" }).pipe(
          Effect.provide(setupModel(response).layer("gemini-3-flash")),
          Effect.flip,
        )
        assert.strictEqual(error.reason._tag, tag)
        assert.isTrue(error.isRetryable)
      }
    }),
  )
})

describe("AntigravityAuth", () => {
  it.effect(
    "signs in with a pasted code and PKCE, onboards, and reuses the stored token",
    () =>
      Effect.gen(function* () {
        const browser = signIn("  auth-code \n")
        const onboard = setupAuth(browser.handler)
        const token = yield* AntigravityAuth.use((auth) => auth.get).pipe(
          Effect.provide(onboard.layer),
        )
        const authUrl = browser.urls[0]!
        const exchange = new URLSearchParams(bodyText(onboard.requests[0]!))
        const clientId =
          "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
        const redirectUri = "https://antigravity.google/oauth-callback"
        assert.strictEqual(
          `${authUrl.origin}${authUrl.pathname}`,
          "https://accounts.google.com/o/oauth2/auth",
        )
        assert.strictEqual(authUrl.searchParams.get("client_id"), clientId)
        assert.strictEqual(
          authUrl.searchParams.get("redirect_uri"),
          redirectUri,
        )
        assert.isNotEmpty(authUrl.searchParams.get("state"))
        assert.strictEqual(exchange.get("client_id"), clientId)
        assert.strictEqual(exchange.get("redirect_uri"), redirectUri)
        assert.isNotEmpty(exchange.get("client_secret"))
        assert.sameMembers(
          authUrl.searchParams.get("scope")?.split(" ") ?? [],
          [
            "https://www.googleapis.com/auth/cloud-platform",
            "https://www.googleapis.com/auth/userinfo.email",
            "https://www.googleapis.com/auth/userinfo.profile",
            "https://www.googleapis.com/auth/cclog",
            "https://www.googleapis.com/auth/experimentsandconfigs",
            "https://www.googleapis.com/auth/aicode",
            "openid",
          ],
        )
        assert.strictEqual(
          authUrl.searchParams.get("code_challenge_method"),
          "S256",
        )
        assert.strictEqual(exchange.get("grant_type"), "authorization_code")
        assert.strictEqual(exchange.get("code"), "auth-code")
        const verifier = exchange.get("code_verifier")!
        assert.isAtLeast(verifier.length, 43)
        assert.strictEqual(
          createHash("sha256").update(verifier).digest("base64url"),
          authUrl.searchParams.get("code_challenge"),
        )
        assert.strictEqual(token.access, "new-access")
        assert.strictEqual(token.refresh, "new-refresh")
        assert.strictEqual(token.project, "onboarded-project")
        assert.deepStrictEqual(onboard.endpoints(), [
          "token",
          "v1internal:loadCodeAssist",
          "v1internal:onboardUser",
        ])
        assert.strictEqual(onboard.json(2).tier_id, "free-tier")

        // A fresh service instance reuses the persisted token without signing in.
        const reused = setupAuth(noSignIn)
        assert.deepStrictEqual(
          yield* AntigravityAuth.use((auth) => auth.get).pipe(
            Effect.provide(reused.layer),
          ),
          token,
        )
        assert.lengthOf(reused.requests, 0)
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )

  it.effect(
    "skips onboarding for an existing project and honors client env overrides",
    () =>
      Effect.gen(function* () {
        const browser = signIn()
        const http = setupAuth(browser.handler, {
          loadCodeAssist: { projectId: { id: "existing-project" } },
          env: {
            CLANKA_ANTIGRAVITY_CLIENT_ID: "custom-id",
            CLANKA_ANTIGRAVITY_CLIENT_SECRET: "custom-secret",
          },
        })
        const token = yield* AntigravityAuth.use((auth) => auth.get).pipe(
          Effect.provide(http.layer),
        )
        assert.strictEqual(
          browser.urls[0]!.searchParams.get("client_id"),
          "custom-id",
        )
        const exchange = new URLSearchParams(bodyText(http.requests[0]!))
        assert.strictEqual(exchange.get("client_id"), "custom-id")
        assert.strictEqual(exchange.get("client_secret"), "custom-secret")
        assert.strictEqual(token.project, "existing-project")
        assert.deepStrictEqual(http.endpoints(), [
          "token",
          "v1internal:loadCodeAssist",
        ])
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )

  it.effect("rejects a blank authorization code", () =>
    Effect.gen(function* () {
      const http = setupAuth(signIn("   ").handler)
      const failure = yield* AntigravityAuth.use((auth) => auth.get).pipe(
        Effect.provide(http.layer),
        Effect.flip,
      )
      assert.strictEqual(failure.reason, "LoginFailed")
      assert.lengthOf(http.requests, 0)
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )

  it.effect(
    "keeps an expired token through a failed refresh and refreshes it later",
    () =>
      Effect.gen(function* () {
        const http = setupAuth(noSignIn, {
          tokenErrors: [{ error: "invalid_client" }],
        })
        const [failure, token] = yield* Effect.gen(function* () {
          const auth = yield* AntigravityAuth
          return [yield* Effect.flip(auth.get), yield* auth.get] as const
        }).pipe(
          Effect.provide(
            http.layer.pipe(
              Layer.provide(
                seedToken({
                  access: "old-access",
                  refresh: "old-refresh",
                  expires: Date.now() - 1000,
                }),
              ),
              Layer.provide(KeyValueStore.layerMemory),
            ),
          ),
        )

        assert.strictEqual(failure.reason, "RefreshFailed")
        assert.strictEqual(token.access, "new-access")
        assert.strictEqual(token.project, "project-1")
        assert.lengthOf(http.requests, 2)
        const refresh = new URLSearchParams(bodyText(http.requests[1]!))
        assert.strictEqual(refresh.get("grant_type"), "refresh_token")
        assert.strictEqual(refresh.get("refresh_token"), "old-refresh")
      }),
  )
})

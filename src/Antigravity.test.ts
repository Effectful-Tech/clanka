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
import * as Compaction from "./Compaction.ts"
import { OAuthCallback } from "./OAuthCallback.ts"

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

const noSignIn: OAuthCallback["Service"] = {
  receive: () => Effect.die("Must not sign in"),
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
        Layer.provide([http.layer, Layer.succeed(OAuthCallback, noSignIn)]),
        Layer.provide(seedToken()),
        Layer.provide(KeyValueStore.layerMemory),
      ),
      ToolsLive,
    )
  return { ...http, layer }
}

const authConfig = ConfigProvider.layer(
  ConfigProvider.fromEnv({
    env: {
      CLANKA_ANTIGRAVITY_CLIENT_ID: "client-id",
      CLANKA_ANTIGRAVITY_CLIENT_SECRET: "client-secret",
    },
  }),
)

const signIn: OAuthCallback["Service"] = {
  receive: ({ url, redirectUri }) =>
    Effect.sync(() => {
      assert.strictEqual(redirectUri, "http://localhost:51121/oauth-callback")
      const state = new URL(url).searchParams.get("state")!
      return new URLSearchParams({ code: "auth-code", state })
    }),
}

const setupAuth = (
  callback: OAuthCallback["Service"],
  options: {
    readonly loadCodeAssist?: unknown
    readonly tokenErrors?: ReadonlyArray<unknown>
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
    Layer.provide([http.layer, Layer.succeed(OAuthCallback, callback)]),
    Layer.provide(authConfig),
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
                sseEvent([{ text: "Listing files.", thought: true }]),
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
    "signs in through the browser, onboarding only when the account has no project",
    () =>
      Effect.gen(function* () {
        const onboard = setupAuth(signIn)
        const token = yield* AntigravityAuth.use((auth) => auth.get).pipe(
          Effect.provide(onboard.layer),
        )
        assert.strictEqual(token.access, "new-access")
        assert.strictEqual(token.refresh, "new-refresh")
        assert.strictEqual(token.project, "onboarded-project")
        const exchange = new URLSearchParams(bodyText(onboard.requests[0]!))
        assert.strictEqual(exchange.get("grant_type"), "authorization_code")
        assert.strictEqual(exchange.get("code"), "auth-code")
        assert.strictEqual(exchange.get("client_id"), "client-id")
        assert.strictEqual(exchange.get("client_secret"), "client-secret")
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

        // An account with an existing project skips onboarding.
        const existing = setupAuth(signIn, {
          loadCodeAssist: { projectId: { id: "existing-project" } },
        })
        const existingToken = yield* AntigravityAuth.use(
          (auth) => auth.get,
        ).pipe(
          Effect.provide(
            existing.layer.pipe(
              Layer.provide(Layer.fresh(KeyValueStore.layerMemory)),
            ),
          ),
        )
        assert.strictEqual(existingToken.project, "existing-project")
        assert.deepStrictEqual(existing.endpoints(), [
          "token",
          "v1internal:loadCodeAssist",
        ])
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

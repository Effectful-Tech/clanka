import { assert, describe, it } from "@effect/vitest"
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
import { TokenData, toTokenStore } from "./AntigravityAuth.ts"
import * as Compaction from "./Compaction.ts"
import { OAuthCallback } from "./OAuthCallback.ts"

const sse = (events: ReadonlyArray<unknown>) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")

// Serves `response` to every request and keeps the requests.
const setup = (response: () => Response) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request)
      return HttpClientResponse.fromWeb(request, response())
    }),
  )
  const seed = Effect.gen(function* () {
    yield* toTokenStore(yield* KeyValueStore.KeyValueStore)
      .set(
        "token",
        new TokenData({
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 3600_000,
          project: "project-1",
        }),
      )
      .pipe(Effect.orDie)
  })
  const layer = (model: string, options?: Antigravity.ModelOptions) =>
    Antigravity.model(model, options).pipe(
      Layer.provide(Antigravity.layerClient),
      Layer.provide([
        Layer.succeed(HttpClient.HttpClient, client),
        Layer.succeed(OAuthCallback, {
          receive: () => Effect.die("Stored credentials must not sign in"),
        }),
      ]),
      Layer.provideMerge(Layer.effectDiscard(seed)),
      Layer.provideMerge(KeyValueStore.layerMemory),
    )
  const body = (index = 0): Record<string, any> => {
    const request = requests[index]!
    if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON")
    return JSON.parse(new TextDecoder().decode(request.body.body))
  }
  return { requests, layer, body }
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

describe("Antigravity provider", () => {
  it.effect(
    "sends a conversation to Cloud Code and streams back thoughts, text and tool calls",
    () =>
      Effect.gen(function* () {
        const http = setup(
          () =>
            new Response(
              sse([
                {
                  response: {
                    responseId: "response-1",
                    modelVersion: "gemini-3-flash",
                    candidates: [
                      {
                        content: {
                          parts: [
                            { text: "Listing files.", thought: true },
                            {
                              text: "",
                              thought: true,
                              thoughtSignature: "sig-1",
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
                {
                  response: {
                    candidates: [
                      { content: { parts: [{ text: "Running ls." }] } },
                    ],
                  },
                },
                {
                  response: {
                    candidates: [
                      {
                        content: {
                          parts: [
                            {
                              functionCall: {
                                id: "call-2",
                                name: "execute",
                                args: { script: "ls" },
                              },
                              thoughtSignature: "sig-2",
                            },
                          ],
                        },
                        finishReason: "STOP",
                      },
                    ],
                    usageMetadata: {
                      promptTokenCount: 100,
                      cachedContentTokenCount: 40,
                      candidatesTokenCount: 20,
                      thoughtsTokenCount: 5,
                    },
                  },
                },
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
            Layer.merge(
              http.layer("gemini-3-flash", { reasoning: { effort: "low" } }),
              ToolsLive,
            ),
          ),
        )

        const request = http.requests[0]!
        assert.strictEqual(
          request.url,
          "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        )
        assert.strictEqual(request.headers.authorization, "Bearer access-token")
        assert.match(request.headers["user-agent"]!, /^antigravity\//)
        const body = http.body()
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
        assert.deepStrictEqual(
          response.content.flatMap((part) =>
            part.type === "reasoning" || part.type === "tool-call"
              ? [part.metadata]
              : [],
          ),
          [
            {
              antigravity: {
                thoughtSignature: "sig-1",
                model: "gemini-3-flash",
              },
            },
            {
              antigravity: {
                thoughtSignature: "sig-2",
                model: "gemini-3-flash",
              },
            },
          ],
        )
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
        const http = setup(
          () =>
            new Response(
              sse([
                {
                  response: {
                    candidates: [
                      {
                        content: {
                          parts: [
                            { text: "Two calls.", thought: true },
                            {
                              text: "",
                              thought: true,
                              thoughtSignature: "sig-1",
                            },
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
                          ],
                        },
                      },
                    ],
                  },
                },
              ]),
            ),
        )
        const turn = (prompt: Prompt.RawInput, model: string) =>
          LanguageModel.streamText({
            prompt,
            toolkit: Tools,
            disableToolCallResolution: true,
          }).pipe(
            Stream.runCollect,
            Effect.provide(Layer.merge(http.layer(model), ToolsLive)),
          )
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
        assert.deepStrictEqual(http.body(1).request.contents[1], {
          role: "model",
          parts: [
            { text: "Two calls.", thought: true, thoughtSignature: "sig-1" },
            { ...calls[0], thoughtSignature: "sig-2" },
            calls[1],
          ],
        })
        assert.deepStrictEqual(http.body(2).request.contents[1], {
          role: "model",
          parts: calls,
        })
      }),
  )

  it.effect("caps compaction summaries for Claude models only", () =>
    Effect.gen(function* () {
      const http = setup(() => new Response(sse([{ response: {} }])))
      const summarize = (model: string) =>
        Effect.gen(function* () {
          const summarize = yield* Compaction.SummarizerTransform
          yield* summarize(LanguageModel.generateText({ prompt: "Summarize" }))
        }).pipe(
          Effect.provide(http.layer(model, { reasoning: { effort: "high" } })),
        )
      yield* summarize("claude-opus-4-6-thinking")
      yield* summarize("gemini-3-flash")
      assert.deepStrictEqual(http.body(0).request.generationConfig, {
        maxOutputTokens: 4000,
        thinkingConfig: { includeThoughts: true, thinkingBudget: 2000 },
      })
      assert.deepStrictEqual(http.body(1).request.generationConfig, {
        thinkingConfig: { includeThoughts: true, thinkingLevel: "high" },
      })
    }),
  )

  // A captured Cloud Code stream: a tool call with usage, no finish reason,
  // and no blank line before the end of the stream.
  it.effect("finishes a tool call turn that ends without a finish reason", () =>
    Effect.gen(function* () {
      const http = setup(
        () =>
          new Response(
            `data: {"response":{"candidates":[{"content":{"parts":[{"thoughtSignature":"CqcECqQEARFNMg8iZ3xVniKaulgBlzhJJDlc","functionCall":{"name":"execute","args":{"script":"ls -la .."},"id":"call_524881"}}],"role":"model"}}],"modelVersion":"gemini-3.7-flash","responseId":"resp-nofr","usageMetadata":{"promptTokenCount":153609,"candidatesTokenCount":17,"totalTokenCount":153720,"thoughtsTokenCount":94}}}\n`,
          ),
      )
      const response = yield* LanguageModel.generateText({
        prompt: "Run ls",
        toolkit: Tools,
        disableToolCallResolution: true,
      }).pipe(
        Effect.provide(Layer.merge(http.layer("gemini-3-flash"), ToolsLive)),
      )
      assert.deepStrictEqual(
        response.toolCalls.map(({ id, params }) => ({ id, params })),
        [{ id: "call_524881", params: { script: "ls -la .." } }],
      )
      assert.strictEqual(response.finishReason, "tool-calls")
      assert.strictEqual(response.usage.inputTokens.total, 153609)
      assert.strictEqual(response.usage.outputTokens.total, 111)
    }),
  )

  it.effect("fails on a backend error after a partial answer", () =>
    Effect.gen(function* () {
      const http = setup(
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
      )
      const error = yield* LanguageModel.generateText({ prompt: "Hi" }).pipe(
        Effect.provide(http.layer("gemini-3-flash")),
        Effect.flip,
      )
      assert.strictEqual(error.reason._tag, "InternalProviderError")
      assert.isTrue(error.isRetryable)
    }),
  )

  it.effect("reports a rate limit as a retryable error", () =>
    Effect.gen(function* () {
      const http = setup(
        () => new Response("Resource has been exhausted", { status: 429 }),
      )
      const error = yield* LanguageModel.generateText({ prompt: "Hi" }).pipe(
        Effect.provide(http.layer("gemini-3-flash")),
        Effect.flip,
      )
      assert.strictEqual(error.reason._tag, "RateLimitError")
      assert.isTrue(error.isRetryable)
    }),
  )
})

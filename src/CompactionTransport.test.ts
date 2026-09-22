import { OpenAiClient } from "@effect/ai-openai"
import { OpenAiClient as CompatClient } from "@effect/ai-openai-compat"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as AiError from "effect/ai/AiError"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Prompt from "effect/ai/Prompt"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Codex from "./Codex.ts"
import * as Compaction from "./Compaction.ts"
import * as Copilot from "./Copilot.ts"

const user = (text: string) =>
  Prompt.makeMessage("user", {
    content: [Prompt.makePart("text", { text })],
  })
const history = Prompt.fromMessages([
  user("old context ".repeat(1_000)),
  user("continue"),
])
const summaryPrompt = Compaction.summarizerPrompt({
  previousSummary: Option.none(),
  messages: history.content,
})

// Use the real provider model and client. Stop at the transport boundary so no
// credentials, network access, or permissive scripted LanguageModel are involved.
const captureHttp = () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request)
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            error: {
              message: "transport probe",
              type: "invalid_request_error",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      )
    }),
  )
  return { requests, layer: Layer.succeed(HttpClient.HttpClient, client) }
}

const body = (
  request: HttpClientRequest.HttpClientRequest,
): Record<string, unknown> => {
  if (request.body._tag !== "Uint8Array")
    throw new Error("expected a JSON request body")
  return JSON.parse(new TextDecoder().decode(request.body.body))
}

const compact = Compaction.compact({
  prompt: history,
  reason: "threshold",
}).pipe(
  Effect.provide(Compaction.CompactionConfig.layer({ keepRecentTokens: 100 })),
)

const streamedSummary = Effect.gen(function* () {
  const ai = yield* LanguageModel.LanguageModel
  const transform = yield* Compaction.SummarizerTransform
  return yield* transform(
    ai.streamText({ prompt: summaryPrompt }).pipe(Stream.runDrain),
  )
})

const socketError = AiError.make({
  module: "test/socket",
  method: "createResponseStream",
  reason: new AiError.InvalidRequestError({ description: "transport probe" }),
})

describe("Compaction provider transport", () => {
  it.effect("sets stream: true on the Codex HTTP summarization request", () =>
    Effect.gen(function* () {
      const http = captureHttp()
      const exit = yield* compact.pipe(
        Effect.provide(
          Codex.model("gpt-6-astra").pipe(
            Layer.provide(
              OpenAiClient.layer({ apiUrl: "https://codex.test" }).pipe(
                Layer.provide(http.layer),
              ),
            ),
          ),
        ),
        Effect.exit,
      )
      assert.isTrue(Exit.isFailure(exit))
      assert.strictEqual(http.requests.length, 1)
      assert.strictEqual(http.requests[0]!.url, "https://codex.test/responses")
      const request = body(http.requests[0]!)
      assert.strictEqual(
        request.stream,
        true,
        "Codex rejects non-streaming responses with HTTP 400",
      )
      assert.isFalse("max_output_tokens" in request)
      assert.deepStrictEqual(request.tools ?? [], [])
    }),
  )

  it.effect(
    "routes compaction through the installed OpenAiSocket rather than HTTP",
    () =>
      Effect.gen(function* () {
        const http = captureHttp()
        const requests: Array<
          Parameters<
            OpenAiClient.OpenAiSocket["Service"]["createResponseStream"]
          >[0]
        > = []
        const exit = yield* compact.pipe(
          Effect.provideService(OpenAiClient.OpenAiSocket, {
            createResponseStream: (request) =>
              Effect.suspend(() => {
                requests.push(request)
                return Effect.fail(socketError)
              }),
          }),
          Effect.provide(
            Codex.model("gpt-6-astra").pipe(
              Layer.provide(
                OpenAiClient.layer({ apiUrl: "https://codex.test" }).pipe(
                  Layer.provide(http.layer),
                ),
              ),
            ),
          ),
          Effect.exit,
        )
        assert.strictEqual(
          http.requests.length,
          0,
          "generateText bypasses the websocket and must not be used here",
        )
        assert.strictEqual(requests.length, 1)
        assert.deepStrictEqual(exit, Exit.fail(socketError))
        assert.isFalse("max_output_tokens" in requests[0]!)
        assert.deepStrictEqual(requests[0]!.tools ?? [], [])
      }),
  )

  it.effect(
    "omits the unsupported Codex output-token cap even when streaming is selected",
    () =>
      Effect.gen(function* () {
        const http = captureHttp()
        yield* streamedSummary.pipe(
          Effect.provide(
            Codex.model("gpt-6-astra").pipe(
              Layer.provide(
                OpenAiClient.layer({ apiUrl: "https://codex.test" }).pipe(
                  Layer.provide(http.layer),
                ),
              ),
            ),
          ),
          Effect.exit,
        )
        assert.strictEqual(http.requests.length, 1)
        const request = body(http.requests[0]!)
        assert.strictEqual(request.stream, true)
        // The live Codex backend rejects this parameter; a 4k cap is unavailable.
        assert.isFalse(
          "max_output_tokens" in request,
          "Codex does not support max_output_tokens",
        )
        assert.deepInclude(request.input, {
          role: "system",
          content: [{ type: "input_text", text: Compaction.summarizerSystem }],
        })
      }),
  )

  it.effect(
    "retains Copilot's 4k wire-level cap only for the streamed summary",
    () =>
      Effect.gen(function* () {
        const http = captureHttp()
        yield* Effect.gen(function* () {
          yield* streamedSummary.pipe(Effect.exit)
          const ai = yield* LanguageModel.LanguageModel
          yield* ai
            .streamText({ prompt: "continue" })
            .pipe(Stream.runDrain, Effect.exit)
        }).pipe(
          Effect.provide(
            Copilot.model("gpt-4.1").pipe(
              Layer.provide(
                CompatClient.layer({ apiUrl: "https://copilot.test" }).pipe(
                  Layer.provide(http.layer),
                ),
              ),
            ),
          ),
        )
        assert.strictEqual(http.requests.length, 2)
        assert.strictEqual(
          http.requests[0]!.url,
          "https://copilot.test/chat/completions",
        )
        const summary = body(http.requests[0]!)
        const continuation = body(http.requests[1]!)
        assert.strictEqual(summary.stream, true)
        // The compatibility client translates max_output_tokens to max_tokens.
        assert.strictEqual(summary.max_tokens, 4_000)
        assert.deepStrictEqual(summary.tools ?? [], [])
        assert.isFalse(
          "max_tokens" in continuation,
          "summary override must not leak into the next model call",
        )
        assert.strictEqual(continuation.stream, true)
      }),
  )
})

import { OpenAiClient } from "@effect/ai-openai-compat"
import { OpenAiClient as ResponsesClient } from "@effect/ai-openai"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Copilot from "./Copilot.ts"

const requestBody = Effect.fnUntraced(function* (
  options: Parameters<typeof Copilot.model>[1],
  model = "gpt-6-astra",
) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request)
      return HttpClientResponse.fromWeb(
        request,
        new Response(null, { status: 400 }),
      )
    }),
  )
  yield* Effect.gen(function* () {
    assert.strictEqual(yield* Model.ProviderName, "copilot")
    assert.strictEqual(yield* Model.ModelName, model)
    const ai = yield* LanguageModel.LanguageModel
    yield* ai.streamText({ prompt: "hello" }).pipe(Stream.runDrain, Effect.exit)
  }).pipe(
    Effect.provide(
      Copilot.model(model, options).pipe(
        Layer.provide(
          Layer.mergeAll(
            OpenAiClient.layer({ apiUrl: "https://copilot.test" }),
            ResponsesClient.layer({ apiUrl: "https://copilot.test" }),
          ),
        ),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      ),
    ),
  )
  assert.lengthOf(requests, 1)
  const body = requests[0]!.body
  if (body._tag !== "Uint8Array") throw new Error("Expected JSON body")
  return {
    url: requests[0]!.url,
    body: JSON.parse(new TextDecoder().decode(body.body)) as Record<
      string,
      unknown
    >,
  }
})

describe("Copilot.model", () => {
  it.effect("sends the given reasoning effort, and none when it is null", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        (yield* requestBody({ reasoning: { effort: "high" } })).body.reasoning,
        { effort: "high" },
      )
      assert.isFalse(
        "reasoning" in (yield* requestBody({ reasoning: null })).body,
      )
    }),
  )
  it.effect("routes Copilot model IDs to their supported API", () =>
    Effect.gen(function* () {
      for (const [model, endpoint] of [
        ["gpt-6-astra", "/responses"],
        ["gpt-6.1-sol", "/responses"],
        ["grok-4.6", "/responses"],
        ["mai-code-1.1-flash", "/responses"],
        ["gpt-5-mini", "/chat/completions"],
        ["gpt-4.1", "/chat/completions"],
        ["claude-fable-5.1", "/chat/completions"],
        ["gemini-4-argon", "/chat/completions"],
      ]) {
        const request = yield* requestBody(undefined, model)
        assert.strictEqual(request.url, "https://copilot.test" + endpoint)
        assert.strictEqual(request.body.model, model)
      }
    }),
  )
})

import { OpenAiClient } from "@effect/ai-openai-compat"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Copilot from "./Copilot.ts"

const requestBody = Effect.fnUntraced(function* (
  options: Parameters<typeof Copilot.model>[1],
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
    const ai = yield* LanguageModel.LanguageModel
    yield* ai.streamText({ prompt: "hello" }).pipe(Stream.runDrain, Effect.exit)
  }).pipe(
    Effect.provide(
      Copilot.model("gpt-6-astra", options).pipe(
        Layer.provide(OpenAiClient.layer({ apiUrl: "https://copilot.test" })),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      ),
    ),
  )
  assert.lengthOf(requests, 1)
  const body = requests[0]!.body
  if (body._tag !== "Uint8Array") throw new Error("Expected JSON body")
  return JSON.parse(new TextDecoder().decode(body.body)) as Record<
    string,
    unknown
  >
})

describe("Copilot.model", () => {
  it.effect("sends the given reasoning effort, and none when it is null", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        (yield* requestBody({ reasoning: { effort: "high" } })).reasoning,
        { effort: "high" },
      )
      assert.isFalse("reasoning" in (yield* requestBody({ reasoning: null })))
    }),
  )
})

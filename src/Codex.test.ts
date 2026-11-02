import { OpenAiClient } from "@effect/ai-openai"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Codex from "./Codex.ts"

const requestBodies = Effect.fnUntraced(function* (
  options: Codex.ModelOptions | undefined,
  calls = 1,
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
    for (let i = 0; i < calls; i++) {
      yield* ai
        .streamText({ prompt: "hello" })
        .pipe(Stream.runDrain, Effect.exit)
    }
  }).pipe(
    Effect.provide(
      Codex.model("gpt-6-astra", options).pipe(
        Layer.provide(OpenAiClient.layer({ apiUrl: "https://codex.test" })),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      ),
    ),
  )
  assert.lengthOf(requests, calls)
  return requests.map((request) => {
    const body = request.body
    if (body._tag !== "Uint8Array") throw new Error("Expected JSON body")
    return JSON.parse(new TextDecoder().decode(body.body)) as Record<
      string,
      unknown
    >
  })
})

const requestBody = (options: Codex.ModelOptions | undefined) =>
  Effect.map(requestBodies(options), (bodies) => bodies[0]!)

describe("Codex.model", () => {
  it.effect("sends medium reasoning with auto summaries by default", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual((yield* requestBody(undefined)).reasoning, {
        effort: "medium",
        summary: "auto",
      })
    }),
  )

  it.effect("sends no reasoning when reasoning is null", () =>
    Effect.gen(function* () {
      assert.isFalse("reasoning" in (yield* requestBody({ reasoning: null })))
    }),
  )

  it.effect("sends one prompt cache key for every request of a model", () =>
    Effect.gen(function* () {
      const [first, second] = yield* requestBodies(undefined, 2)
      assert.isString(first!.prompt_cache_key)
      assert.isNotEmpty(first!.prompt_cache_key)
      assert.strictEqual(second!.prompt_cache_key, first!.prompt_cache_key)
      const [other] = yield* requestBodies(undefined)
      assert.notStrictEqual(other!.prompt_cache_key, first!.prompt_cache_key)
    }),
  )

  it.effect("keeps a prompt cache key the caller sets", () =>
    Effect.gen(function* () {
      const body = yield* requestBody({ prompt_cache_key: "session-1" })
      assert.strictEqual(body.prompt_cache_key, "session-1")
    }),
  )
})

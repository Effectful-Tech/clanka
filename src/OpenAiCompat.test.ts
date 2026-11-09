import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Compaction from "./Compaction.ts"
import * as ModelsRepo from "./ModelsRepo.ts"
import * as OpenAiCompat from "./OpenAiCompat.ts"

const client = {
  apiUrl: "https://proxy.test/v1",
  apiKey: Redacted.make("proxy-key"),
}

// An HttpClient that records its requests and answers each with `response`.
const recording = (response: () => Response) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request)
        return HttpClientResponse.fromWeb(request, response())
      }),
    ),
  )
  return { requests, layer }
}

const jsonBody = (request: HttpClientRequest.HttpClientRequest) => {
  if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON body")
  return JSON.parse(new TextDecoder().decode(request.body.body)) as Record<
    string,
    unknown
  >
}

// The requests a prompt sends, then the same prompt as a compaction summary.
const send = Effect.fnUntraced(function* (options?: OpenAiCompat.ModelOptions) {
  const http = recording(() => new Response(null, { status: 400 }))
  yield* Effect.gen(function* () {
    const ai = yield* LanguageModel.LanguageModel
    const summarize = yield* Compaction.SummarizerTransform
    const request = ai.streamText({ prompt: "hello" }).pipe(Stream.runDrain)
    yield* request.pipe(Effect.exit)
    yield* summarize(request).pipe(Effect.exit)
  }).pipe(
    Effect.provide(
      OpenAiCompat.model("kimi-k3", options).pipe(
        Layer.provide(OpenAiCompat.layerClient(client)),
        Layer.provide(http.layer),
      ),
    ),
  )
  assert.lengthOf(http.requests, 2)
  return http.requests
})

describe("OpenAiCompat.model", () => {
  it.effect("streams chat completions from the configured endpoint", () =>
    Effect.gen(function* () {
      const [request] = yield* send()
      assert.strictEqual(request!.url, "https://proxy.test/v1/chat/completions")
      assert.strictEqual(request!.headers.authorization, "Bearer proxy-key")
      assert.strictEqual(jsonBody(request!).model, "kimi-k3")
    }),
  )

  it.effect("sends the effort as reasoning_effort, and none when null", () =>
    Effect.gen(function* () {
      const [high] = yield* send({ reasoning: { effort: "high" } })
      assert.strictEqual(jsonBody(high!).reasoning_effort, "high")
      assert.isFalse("reasoning" in jsonBody(high!))
      for (const options of [{ reasoning: null }, undefined]) {
        const [request] = yield* send(options)
        assert.isFalse("reasoning_effort" in jsonBody(request!))
        assert.isFalse("reasoning" in jsonBody(request!))
      }
    }),
  )

  it.effect("caps compaction summaries with max_tokens", () =>
    Effect.gen(function* () {
      const [prompt, summary] = yield* send()
      assert.isFalse("max_tokens" in jsonBody(prompt!))
      assert.strictEqual(
        jsonBody(summary!).max_tokens,
        Compaction.summarizerMaxOutputTokens,
      )
    }),
  )
})

const base = new ModelsRepo.ModelInfo({
  provider: "openai",
  id: "gpt-6-astra",
  name: "GPT-6 Astra",
  efforts: ["low", "high"],
})

// The catalog of a repo over `base` and an endpoint answering `response`.
const catalog = (response: () => Response) => {
  const http = recording(response)
  return Effect.gen(function* () {
    const repo = yield* ModelsRepo.ModelsRepo
    const first = yield* repo.models
    assert.deepStrictEqual(yield* repo.models, first)
    return { models: first, requests: http.requests }
  }).pipe(
    Effect.provide(
      OpenAiCompat.layerModelsRepo(client).pipe(
        Layer.provide([ModelsRepo.ModelsRepo.layer([base]), http.layer]),
      ),
    ),
  )
}

describe("OpenAiCompat.layerModelsRepo", () => {
  it.effect(
    "appends the listed models, newest first, with unknown efforts",
    () =>
      Effect.gen(function* () {
        const { models, requests } = yield* catalog(() =>
          Response.json({
            object: "list",
            data: [
              { id: "kimi-k2", object: "model", created: 1 },
              { id: "kimi-k3", object: "model", created: 3 },
              { object: "model" },
              { id: "custom", object: "model" },
            ],
          }),
        )
        assert.lengthOf(requests, 1)
        assert.strictEqual(requests[0]!.url, "https://proxy.test/v1/models")
        assert.strictEqual(
          requests[0]!.headers.authorization,
          "Bearer proxy-key",
        )
        assert.deepStrictEqual(models, [
          base,
          ...["kimi-k3", "kimi-k2", "custom"].map(
            (id) =>
              new ModelsRepo.ModelInfo({
                provider: "openai-compat",
                id,
                name: id,
              }),
          ),
        ])
      }),
  )

  it.effect("keeps the catalog when the endpoint cannot be listed", () =>
    Effect.gen(function* () {
      const { models } = yield* catalog(
        () => new Response(null, { status: 401 }),
      )
      assert.deepStrictEqual(models, [base])
    }),
  )
})

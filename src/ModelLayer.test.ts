import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Socket from "effect/socket/Socket"
import type * as Acp from "./Acp.ts"
import { DeviceCodeHandler } from "./DeviceCodeHandler.ts"
import * as ModelLayer from "./ModelLayer.ts"
import * as ModelsRepo from "./ModelsRepo.ts"

const makeModel = ModelLayer.makeAcp({
  models: Effect.succeed([
    new ModelsRepo.ModelInfo({
      provider: "openai",
      id: "gpt-4.1",
      name: "GPT-4.1",
      efforts: [],
    }),
    new ModelsRepo.ModelInfo({
      provider: "openai",
      id: "gpt-6-astra",
      name: "GPT-6 Astra",
      efforts: ["low", "high"],
    }),
    new ModelsRepo.ModelInfo({
      provider: "openai",
      id: "gpt-5-pro",
      name: "GPT-5 Pro",
      efforts: ["high"],
    }),
  ]),
  openai: {
    apiKey: Redacted.make("test-key"),
    apiUrl: "https://codex.test",
  },
})

// The other providers' login and socket services, which the API-key openai
// path must not use.
const unused = Layer.mergeAll(
  KeyValueStore.layerMemory,
  Layer.succeed(DeviceCodeHandler, {
    onCode: () => Effect.die("The API-key path must not log in"),
  }),
  Layer.succeed(Socket.WebSocketConstructor, () => {
    throw new Error("Unexpected live WebSocket")
  }),
)

// The request body the model for `modelId` sends at session thought level
// `thoughtLevel`.
const requestBody = Effect.fnUntraced(function* (
  modelId: string,
  thoughtLevel: Acp.ThoughtLevel = "high",
  fastMode = false,
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
  const model = Option.getOrThrow(makeModel(modelId, thoughtLevel, fastMode))
  yield* Effect.gen(function* () {
    const ai = yield* LanguageModel.LanguageModel
    yield* ai.streamText({ prompt: "hello" }).pipe(Stream.runDrain, Effect.exit)
  }).pipe(
    Effect.provide(
      model.pipe(
        Layer.provide([Layer.succeed(HttpClient.HttpClient, client), unused]),
      ),
    ),
  )
  assert.lengthOf(requests, 1)
  const body = requests[0]!.body
  if (body._tag !== "Uint8Array") throw new Error("Expected JSON body")
  return JSON.parse(new TextDecoder().decode(body.body)) as Record<string, any>
})

describe("ModelLayer.makeAcp", () => {
  it.effect("sends no reasoning for a catalog model without efforts", () =>
    Effect.gen(function* () {
      assert.isFalse("reasoning" in (yield* requestBody("openai:gpt-4.1")))
    }),
  )

  for (const modelId of ["openai:gpt-6-astra", "openai:gpt-unlisted"]) {
    it.effect("sends the session effort for " + modelId, () =>
      Effect.gen(function* () {
        assert.strictEqual(
          (yield* requestBody(modelId)).reasoning?.effort,
          "high",
        )
      }),
    )
  }

  it.effect(
    "sends a supported effort when the catalog model lacks the session effort",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(
          (yield* requestBody("openai:gpt-5-pro", "medium")).reasoning?.effort,
          "high",
        )
      }),
  )

  it.effect("sends the priority service tier in fast mode only", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        (yield* requestBody("openai:gpt-6-astra", "high", true)).service_tier,
        "priority",
      )
      assert.isFalse(
        "service_tier" in (yield* requestBody("openai:gpt-6-astra")),
      )
    }),
  )

  it("rejects ids that are not <provider>:<model>", () => {
    assert.isTrue(Option.isNone(makeModel("nope", "high")))
  })

  it("builds claude models", () => {
    assert.isTrue(Option.isSome(makeModel("claude:claude-opus-5-5", "high")))
  })
})

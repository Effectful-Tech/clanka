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
import * as Agent from "./Agent.ts"
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
    // Discovered from an endpoint's /models, which lists no efforts.
    new ModelsRepo.ModelInfo({
      provider: "openai-compat",
      id: "kimi-k3",
      name: "kimi-k3",
    }),
  ]),
  openai: {
    apiKey: Redacted.make("test-key"),
    apiUrl: "https://codex.test",
  },
  auxiliary: { subagent: { provider: "openai", model: "gpt-4.1" } },
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
// `thoughtLevel`, or its sub-agent model with `subagent`.
const requestBody = Effect.fnUntraced(function* (
  modelId: string,
  thoughtLevel: Acp.ThoughtLevel = "high",
  fastMode = false,
  subagent = false,
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
  const send = Effect.gen(function* () {
    const ai = yield* LanguageModel.LanguageModel
    yield* ai.streamText({ prompt: "hello" }).pipe(Stream.runDrain, Effect.exit)
  })
  yield* Effect.gen(function* () {
    yield* subagent ? Effect.provide(send, yield* Agent.SubagentModel) : send
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

  it.effect("runs sub-agents on the auxiliary sub-agent model", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        (yield* requestBody("openai:gpt-6-astra", "high", false, true)).model,
        "gpt-4.1",
      )
    }),
  )

  for (const modelId of ["openai-compat:kimi-k3", "openai-compat:kimi-k9"]) {
    it.effect(
      "runs " + modelId + " on chat completions at the session effort",
      () =>
        Effect.gen(function* () {
          const body = yield* requestBody(modelId, "low", true)
          assert.strictEqual(body.model, modelId.slice("openai-compat:".length))
          assert.isArray(body.messages)
          assert.strictEqual(body.reasoning_effort, "low")
          assert.isFalse("service_tier" in body)
        }),
    )
  }

  it.effect("keeps colons in the model id", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        (yield* requestBody("openai-compat:qwen3:8b")).model,
        "qwen3:8b",
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

describe("ModelLayer.parseModelSpec", () => {
  it("splits off a trailing effort and keeps slashes in the model id", () => {
    assert.deepStrictEqual(
      ModelLayer.parseModelSpec("openai/gpt-6-astra/medium"),
      Option.some({
        provider: "openai",
        model: "gpt-6-astra",
        effort: "medium",
      }),
    )
    assert.deepStrictEqual(
      ModelLayer.parseModelSpec("openai-compat/moonshotai/Kimi-K2-Instruct"),
      Option.some({
        provider: "openai-compat",
        model: "moonshotai/Kimi-K2-Instruct",
        effort: undefined,
      }),
    )
    assert.deepStrictEqual(
      ModelLayer.parseModelSpec(
        "openai-compat/moonshotai/Kimi-K2-Instruct/high",
      ),
      Option.some({
        provider: "openai-compat",
        model: "moonshotai/Kimi-K2-Instruct",
        effort: "high",
      }),
    )
    assert.isTrue(Option.isNone(ModelLayer.parseModelSpec("nope/gpt-6-astra")))
    assert.isTrue(Option.isNone(ModelLayer.parseModelSpec("openai")))
  })
})

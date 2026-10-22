import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as ModelsRepo from "./ModelsRepo.ts"

// A trimmed `https://models.dev/api.json`: one provider clanka does not
// offer, and per provider the entries the catalog must keep and drop.
const apiJson = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-6-astra": {
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        tool_call: true,
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["low", "medium", "high", "xhigh", "max"],
          },
        ],
      },
      "gpt-4": {
        id: "gpt-4",
        name: "GPT-4",
        tool_call: true,
        reasoning: false,
        status: "deprecated",
      },
      "gpt-image-2": {
        id: "gpt-image-2",
        name: "GPT Image 2",
        type: "image",
        tool_call: false,
        reasoning: false,
      },
      "text-embedding-3-small": {
        id: "text-embedding-3-small",
        name: "text-embedding-3-small",
        type: "embedding",
        tool_call: false,
        reasoning: false,
      },
      "gpt-chat-only": {
        id: "gpt-chat-only",
        name: "GPT Chat Only",
        tool_call: false,
        reasoning: false,
      },
    },
  },
  "github-copilot": {
    id: "github-copilot",
    name: "GitHub Copilot",
    models: {
      "claude-fable-5.1": {
        id: "claude-fable-5.1",
        name: "Claude Fable 5.1",
        tool_call: true,
        reasoning: true,
        reasoning_options: [
          { type: "effort", values: ["low", "turbo", "high"] },
          { type: "budget_tokens", min: 1024, max: 32000 },
        ],
      },
    },
  },
  xai: {
    id: "xai",
    name: "xAI",
    models: {
      "grok-4.6": {
        id: "grok-4.6",
        name: "Grok 4.6",
        tool_call: true,
        reasoning: true,
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high", "xhigh"] },
        ],
      },
      "grok-build-0.1": {
        id: "grok-build-0.1",
        name: "Grok Build 0.1",
        tool_call: true,
        reasoning: true,
        reasoning_options: [],
      },
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-opus-5.5": {
        id: "claude-opus-5.5",
        name: "Claude Opus 5.5",
        tool_call: true,
        reasoning: true,
      },
    },
  },
}

const catalog = [
  new ModelsRepo.ModelInfo({
    provider: "openai",
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    efforts: ["low", "medium", "high", "xhigh", "max"],
  }),
  new ModelsRepo.ModelInfo({
    provider: "copilot",
    id: "claude-fable-5.1",
    name: "Claude Fable 5.1",
    efforts: ["low", "high"],
  }),
  new ModelsRepo.ModelInfo({
    provider: "xai",
    id: "grok-4.6",
    name: "Grok 4.6",
    efforts: ["low", "medium", "high", "xhigh"],
  }),
  new ModelsRepo.ModelInfo({
    provider: "xai",
    id: "grok-build-0.1",
    name: "Grok Build 0.1",
    efforts: [],
  }),
]

const online = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(apiJson), {
        headers: { "content-type": "application/json" },
      }),
    ),
  ),
)

const offline = HttpClient.make((request) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        request,
        cause: new Error("getaddrinfo ENOTFOUND models.dev"),
      }),
    }),
  ),
)

const modelsWith = (client: HttpClient.HttpClient) =>
  Effect.flatMap(ModelsRepo.ModelsRepo, (repo) => repo.models).pipe(
    Effect.provide(
      ModelsRepo.ModelsRepo.layerModelsDev().pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      ),
    ),
  )

describe("ModelsRepo.layerModelsDev", () => {
  it.effect(
    "lists the openai, copilot and xai text models that accept tool calls",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* modelsWith(online), catalog)
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )

  it.effect("serves the cached catalog when models.dev is unreachable", () =>
    Effect.gen(function* () {
      yield* modelsWith(online)
      assert.deepStrictEqual(yield* modelsWith(offline), catalog)
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )
})

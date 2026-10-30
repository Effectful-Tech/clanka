import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as TestClock from "effect/testing/TestClock"
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
      "claude-opus-5-5": {
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        tool_call: true,
        reasoning: true,
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
        ],
      },
    },
  },
  google: {
    id: "google",
    name: "Google",
    models: {
      "gemini-4-pro": {
        id: "gemini-4-pro",
        name: "Gemini 4 Pro",
        tool_call: true,
        reasoning: true,
      },
    },
  },
}

const catalog = [
  new ModelsRepo.ModelInfo({
    provider: "copilot",
    id: "claude-fable-5.1",
    name: "Claude Fable 5.1",
    efforts: ["low", "high"],
  }),
  new ModelsRepo.ModelInfo({
    provider: "claude",
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    efforts: ["low", "medium", "high", "xhigh", "max"],
  }),
  new ModelsRepo.ModelInfo({
    provider: "openai",
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    efforts: ["low", "medium", "high", "xhigh", "max"],
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

// Fails every request and counts the attempts.
const offline = () => {
  let requests = 0
  const client = HttpClient.make((request) =>
    Effect.suspend(() => {
      requests++
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            cause: new Error("getaddrinfo ENOTFOUND models.dev"),
          }),
        }),
      )
    }),
  )
  return { client, requests: () => requests }
}

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
    "lists the openai, copilot, xai and anthropic text models that accept tool calls",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* modelsWith(online), catalog)
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )

  it.effect("keeps the 10 newest models, breaking date ties by name", () =>
    Effect.gen(function* () {
      const models = Object.fromEntries(
        [
          ["oldest", "Alpha old", "2020-01-01"],
          ["undated-z", "Zulu undated"],
          ["first-tie", "Zulu tie", "2026-06-01"],
          ["march", "Gamma", "2026-03-01"],
          ["newest", "Zulu newest", "2026-10-01"],
          ["january", "Delta", "2026-01-01"],
          ["undated-a", "Alpha undated"],
          ["december", "Epsilon", "2025-12-01"],
          ["second-tie", "Alpha tie", "2026-06-01"],
          ["november", "Eta", "2025-11-01"],
          ["older", "Theta", "2024-01-01"],
        ].map(([id, name, release_date]) => [
          id,
          { id, name, release_date, tool_call: true },
        ]),
      )
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ openai: { models } }), {
              headers: { "content-type": "application/json" },
            }),
          ),
        ),
      )
      assert.deepStrictEqual(
        (yield* modelsWith(client)).map((model) => model.id),
        [
          "newest",
          "second-tie",
          "first-tie",
          "march",
          "january",
          "december",
          "november",
          "older",
          "oldest",
          "undated-a",
        ],
      )
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )

  it.effect("serves an expired cached catalog when the refresh fails", () =>
    Effect.gen(function* () {
      yield* modelsWith(online)
      yield* TestClock.adjust("25 hours")
      const http = offline()
      assert.deepStrictEqual(yield* modelsWith(http.client), catalog)
      assert.strictEqual(http.requests(), 1)
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )

  it.effect(
    "serves the built-in catalog when models.dev is unreachable and nothing is cached",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* modelsWith(offline().client),
          ModelsRepo.fallback,
        )
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )

  it("has a built-in model for every provider", () => {
    for (const provider of ModelsRepo.Provider.literals) {
      assert.isTrue(
        ModelsRepo.fallback.some((model) => model.provider === provider),
        provider,
      )
    }
  })
})

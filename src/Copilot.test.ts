import { OpenAiClient } from "@effect/ai-openai-compat"
import { OpenAiClient as ResponsesClient } from "@effect/ai-openai"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Copilot from "./Copilot.ts"
import { CopilotModels, diagnoseCatalog } from "./CopilotModels.ts"

// Deliberately different from public-provider names; these are catalog fixtures,
// not a hard-coded list of real Copilot models.
const catalog = [
  {
    id: "copilot-only-id",
    name: "Friendly model name",
    supported_endpoints: ["/responses"],
    capabilities: {
      supports: {
        tool_calls: true,
        reasoning_effort: ["low", "high", "unknown"],
      },
    },
  },
  {
    id: "gpt-6-astra",
    name: "Chat fixture",
    supported_endpoints: ["/chat/completions"],
    capabilities: { supports: { tool_calls: true } },
  },
]

const requestModel = Effect.fnUntraced(function* (
  options: Parameters<typeof Copilot.model>[1],
  model = "copilot-only-id",
) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.url.endsWith("/models")) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ data: catalog }),
        )
      }
      requests.push(request)
      return HttpClientResponse.fromWeb(
        request,
        new Response(null, { status: 400 }),
      )
    }),
  )
  const result = yield* Effect.gen(function* () {
    const ai = yield* LanguageModel.LanguageModel
    yield* ai.streamText({ prompt: "hello" }).pipe(Stream.runDrain, Effect.exit)
  }).pipe(
    Effect.provide(
      Copilot.model(model, options).pipe(
        Layer.provide(
          Layer.mergeAll(
            OpenAiClient.layer({ apiUrl: "https://copilot.test" }),
            ResponsesClient.layer({ apiUrl: "https://copilot.test" }),
            CopilotModels.layer,
          ),
        ),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      ),
    ),
    Effect.exit,
  )
  return { requests, result }
})

const requestBody = Effect.fnUntraced(function* (
  options: Parameters<typeof Copilot.model>[1],
  model = "copilot-only-id",
) {
  const { requests, result } = yield* requestModel(options, model)
  assert.isTrue(Exit.isSuccess(result))
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
  it.effect(
    "diagnoses catalog shape without printing credentials or arbitrary strings",
    () =>
      Effect.gen(function* () {
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                access_token: "top-level-secret",
                data: [
                  {
                    id: "secret-id",
                    name: "secret-name",
                    access_token: "model-secret",
                    model_picker_enabled: true,
                    supported_endpoints: ["/responses", "secret-endpoint"],
                    policy: { state: "secret-state" },
                    capabilities: {
                      supports: {
                        tool_calls: "secret-value",
                        reasoning_effort: ["high", "secret-effort"],
                      },
                    },
                  },
                ],
              }),
            ),
          ),
        )
        const diagnostic = yield* diagnoseCatalog.pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        )
        assert.strictEqual(diagnostic.count, 1)
        assert.strictEqual(diagnostic.entries[0]?.eligibility, "decode_failed")
        assert.notInclude(JSON.stringify(diagnostic), "secret")
      }),
  )
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
        ["copilot-only-id", "/responses"],
        ["gpt-6-astra", "/chat/completions"],
      ]) {
        const request = yield* requestBody(undefined, model)
        assert.strictEqual(request.url, "https://copilot.test" + endpoint)
        assert.strictEqual(request.body.model, model)
      }
    }),
  )
  it.effect(
    "rejects IDs absent from the account catalog before inference",
    () =>
      Effect.gen(function* () {
        const { requests, result } = yield* requestModel(
          undefined,
          "other-provider-name",
        )
        assert.lengthOf(requests, 0)
        assert.isTrue(Exit.isFailure(result))
        assert.include(
          String(result),
          'does not advertise model "other-provider-name"',
        )
      }),
  )
})

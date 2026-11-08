import { assert, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Socket from "effect/socket/Socket"
import { CopilotModels } from "./CopilotModels.ts"
import { DeviceCodeHandler } from "./DeviceCodeHandler.ts"
import { STORE_TOKEN_KEY, TokenData, toTokenStore } from "./CopilotAuth.ts"
import * as ModelLayer from "./ModelLayer.ts"

it.effect(
  "keeps policy-enabled callable models when the picker flag is false",
  () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              data: [
                {
                  id: "gpt-4.1",
                  name: "GPT 4.1",
                  policy: { state: "enabled" },
                  model_picker_enabled: false,
                  supported_endpoints: ["/chat/completions"],
                  capabilities: { supports: { tool_calls: true } },
                },
              ],
            }),
          ),
        ),
      )
      const models = yield* CopilotModels.use((repo) => repo.models).pipe(
        Effect.provide(CopilotModels.layer),
        Effect.provideService(HttpClient.HttpClient, client),
      )
      assert.deepStrictEqual(
        models.map((model) => model.id),
        ["gpt-4.1"],
      )
    }),
)

it.effect("building the authenticated catalog alone does not log in", () =>
  CopilotModels.pipe(
    Effect.provide(CopilotModels.layerAuthenticated),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected HTTP")),
    ),
    Effect.provideService(DeviceCodeHandler, {
      onCode: () => Effect.die("Unexpected login"),
    }),
    Effect.provide(KeyValueStore.layerMemory),
    Effect.asVoid,
  ),
)

it.effect(
  "uses the live effort on an ACP Copilot model absent from the default-provider catalog",
  () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore
      yield* toTokenStore(store).set(
        STORE_TOKEN_KEY,
        new TokenData({ access: "fixture", expires: 0 }),
      )
      for (const { efforts, expected } of [
        { efforts: ["high"], expected: { effort: "high" } },
        { efforts: [], expected: undefined },
      ]) {
        let body: { reasoning?: { effort?: string } } = {}
        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            if (request.url.endsWith("/models"))
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  data: [
                    {
                      id: "account-model",
                      name: "Account model",
                      supported_endpoints: ["/responses"],
                      capabilities: {
                        supports: {
                          tool_calls: true,
                          reasoning_effort: efforts,
                        },
                      },
                    },
                  ],
                }),
              )
            if (request.body._tag !== "Uint8Array")
              throw new Error("Expected JSON body")
            body = JSON.parse(new TextDecoder().decode(request.body.body))
            return HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: 400 }),
            )
          }),
        )
        const makeModel = ModelLayer.makeAcp({
          models: Effect.succeed([]),
          openai: {},
        })
        const layer = Option.getOrThrow(
          makeModel("copilot:account-model", "medium"),
        )
        yield* Effect.gen(function* () {
          const ai = yield* LanguageModel.LanguageModel
          yield* ai
            .streamText({ prompt: "hello" })
            .pipe(Stream.runDrain, Effect.exit)
        }).pipe(
          Effect.provide(layer),
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(DeviceCodeHandler, {
            onCode: () => Effect.die("Unexpected login"),
          }),
          Effect.provideService(Socket.WebSocketConstructor, () => {
            throw new Error("Unexpected socket")
          }),
        )
        assert.deepStrictEqual(body.reasoning, expected)
      }
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
)

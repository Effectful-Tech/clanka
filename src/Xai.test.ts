import { assert, describe, it } from "@effect/vitest"
import { OpenAiClient } from "@effect/ai-openai"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Socket from "effect/socket/Socket"
import * as Compaction from "./Compaction.ts"
import { DeviceCodeHandler } from "./DeviceCodeHandler.ts"
import * as Public from "./index.ts"
import * as Xai from "./Xai.ts"
import { TokenData, toTokenStore } from "./XaiAuth.ts"

const capture = () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request)
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            error: {
              message: "transport probe",
              type: "invalid_request_error",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      )
    }),
  )
  return { requests, layer: Layer.succeed(HttpClient.HttpClient, client) }
}
const body = (
  request: HttpClientRequest.HttpClientRequest,
): Record<string, unknown> => {
  if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON body")
  return JSON.parse(new TextDecoder().decode(request.body.body))
}
const seed = Effect.gen(function* () {
  yield* toTokenStore(yield* KeyValueStore.KeyValueStore)
    .set(
      "token",
      new TokenData({
        access: "subscription-token",
        refresh: "refresh",
        expires: Date.now() + 3600000,
      }),
    )
    .pipe(Effect.orDie)
})
const noLogin = Layer.succeed(DeviceCodeHandler, {
  onCode: () => Effect.die("Cached credentials must not prompt"),
})

describe("Xai provider", () => {
  it.todo(
    "replays WebSocket history inline with storage enabled once upstream supports disabling item references",
  )

  for (const store of [undefined, false, true] as const) {
    it.effect("always stores WebSocket responses with store=" + store, () =>
      Effect.gen(function* () {
        const http = capture()
        const requests: Array<
          Parameters<
            OpenAiClient.OpenAiSocket["Service"]["createResponseStream"]
          >[0]
        > = []
        yield* Effect.gen(function* () {
          const ai = yield* LanguageModel.LanguageModel
          const summarize = yield* Compaction.SummarizerTransform
          const request = ai
            .streamText({ prompt: "hello" })
            .pipe(Stream.runDrain)
          yield* request.pipe(Effect.exit)
          yield* summarize(request).pipe(Effect.exit)
        }).pipe(
          Effect.provideService(OpenAiClient.OpenAiSocket, {
            createResponseStream: (request) =>
              Effect.sync(() => {
                requests.push(request)
                return [
                  HttpClientResponse.fromWeb(
                    HttpClientRequest.post("https://api.x.ai/v1/responses"),
                    new Response(),
                  ),
                  Stream.empty,
                ] as const
              }),
          }),
          Effect.provide(
            Xai.modelWebSocket(
              "grok-4.6",
              store === undefined ? undefined : { store },
            ).pipe(
              Layer.provide(
                OpenAiClient.layer({ apiUrl: "https://api.x.ai/v1" }),
              ),
              Layer.provide(http.layer),
              Layer.provide(
                Layer.succeed(Socket.WebSocketConstructor, () => {
                  throw new Error("Unexpected live WebSocket")
                }),
              ),
            ),
          ),
        )
        assert.lengthOf(http.requests, 0)
        assert.lengthOf(requests, 2)
        for (const request of requests) assert.strictEqual(request.store, true)
        assert.isUndefined(requests[0]!.max_output_tokens)
        assert.strictEqual(requests[1]!.max_output_tokens, 4000)
      }),
    )
  }

  it("exports Xai, but not XaiAuth, from the public entry point", () => {
    assert.strictEqual(Public.Xai, Xai)
    assert.isFalse("XaiAuth" in Public)
    assert.strictEqual(Xai.model("grok-4.6").provider, "xai")
  })

  for (const effort of [undefined, "low"] as const) {
    it.effect(
      "uses authenticated HTTP Responses with " +
        (effort ?? "default high") +
        " reasoning",
      () =>
        Effect.gen(function* () {
          yield* seed
          const http = capture()
          yield* Effect.gen(function* () {
            assert.lengthOf(
              http.requests,
              0,
              "Client construction must not trigger login or inference",
            )
            assert.strictEqual(yield* Model.ProviderName, "xai")
            assert.strictEqual(yield* Model.ModelName, "grok-4.6")
            const ai = yield* LanguageModel.LanguageModel
            const exit = yield* ai
              .streamText({ prompt: "hello" })
              .pipe(Stream.runDrain, Effect.exit)
            assert.isTrue(Exit.isFailure(exit))
          }).pipe(
            Effect.provide(
              Xai.model(
                "grok-4.6",
                effort === undefined ? undefined : { reasoning: { effort } },
              ).pipe(
                Layer.provide(Xai.layerClient),
                Layer.provide(http.layer),
                Layer.provide(noLogin),
              ),
            ),
          )
          assert.lengthOf(http.requests, 1)
          const request = http.requests[0]!
          assert.strictEqual(request.method, "POST")
          assert.strictEqual(request.url, "https://api.x.ai/v1/responses")
          assert.strictEqual(
            request.headers.authorization,
            "Bearer subscription-token",
          )
          assert.match(request.headers["user-agent"]!, /clanka/i)
          assert.notMatch(request.headers["user-agent"]!, /opencode/i)
          assert.deepInclude(body(request), {
            model: "grok-4.6",
            store: false,
            stream: true,
          })
          assert.deepInclude(body(request).reasoning, {
            effort: effort ?? "high",
          })
          assert.isFalse("max_output_tokens" in body(request))
        }).pipe(Effect.provide(KeyValueStore.layerMemory)),
    )
  }

  it.effect(
    "caps summaries at 4k without leaking the cap into subsequent requests",
    () =>
      Effect.gen(function* () {
        yield* seed
        const http = capture()
        yield* Effect.gen(function* () {
          const ai = yield* LanguageModel.LanguageModel
          const summarize = yield* Compaction.SummarizerTransform
          yield* summarize(
            ai.streamText({ prompt: "summarize" }).pipe(Stream.runDrain),
          ).pipe(Effect.exit)
          yield* ai
            .streamText({ prompt: "continue" })
            .pipe(Stream.runDrain, Effect.exit)
        }).pipe(
          Effect.provide(
            Xai.model("grok-4.6").pipe(
              Layer.provide(Xai.layerClient),
              Layer.provide(http.layer),
              Layer.provide(noLogin),
            ),
          ),
        )
        assert.lengthOf(http.requests, 2)
        assert.strictEqual(body(http.requests[0]!).max_output_tokens, 4000)
        assert.isFalse("max_output_tokens" in body(http.requests[1]!))
        for (const request of http.requests) {
          assert.strictEqual(request.url, "https://api.x.ai/v1/responses")
          assert.strictEqual(body(request).store, false)
        }
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )
})

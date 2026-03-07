import { Generated, OpenAiClient } from "@effect/ai-openai"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Encoding, Layer, Option, Ref } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { KeyValueStore } from "effect/unstable/persistence"
import * as Codex from "./Codex.ts"
import { CodexAuth, ISSUER, TokenData } from "./CodexAuth.ts"
import * as PublicApi from "./index.ts"

const DEFAULT_MODEL = "gpt-5.3-codex"

const createJwt = (payload: string): string =>
  `${Encoding.encodeBase64Url(JSON.stringify({ alg: "none" }))}.${Encoding.encodeBase64Url(payload)}.sig`

const createTestJwt = (payload: Record<string, unknown>): string =>
  createJwt(JSON.stringify(payload))

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  })

const getBody = (request: HttpClientRequest.HttpClientRequest): string => {
  if (request.body._tag !== "Uint8Array") {
    throw new Error("Expected request body to be a Uint8Array payload")
  }

  return new TextDecoder().decode(request.body.body)
}

const makeClient = Effect.fn("makeClient")(function* (
  handler: (
    request: HttpClientRequest.HttpClientRequest,
    attempt: number,
  ) => Response,
) {
  const attempts = yield* Ref.make(0)
  const requests = yield* Ref.make<Array<HttpClientRequest.HttpClientRequest>>(
    [],
  )
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1)
      yield* Ref.update(requests, (current) => [...current, request])
      return HttpClientResponse.fromWeb(request, handler(request, attempt))
    }),
  )

  return {
    attempts,
    client,
    requests,
  } as const
})

const makeResponse = (
  overrides: Partial<Generated.Response> = {},
): Generated.Response => ({
  id: "resp_test123",
  object: "response",
  created_at: Math.floor(Date.now() / 1_000),
  model: DEFAULT_MODEL,
  status: "completed",
  output: [],
  metadata: null,
  temperature: null,
  top_p: null,
  tools: [],
  tool_choice: "auto",
  error: null,
  incomplete_details: null,
  instructions: null,
  parallel_tool_calls: false,
  ...overrides,
})

describe("Codex", () => {
  it.effect(
    "injects bearer and account headers through CodexAuth.layerClient",
    () =>
      Effect.gen(function* () {
        const { client, requests } = yield* makeClient(
          () => new Response(null, { status: 204 }),
        )

        const layer = CodexAuth.layerClient.pipe(
          Layer.provide(
            Layer.succeed(
              CodexAuth,
              CodexAuth.of({
                get: Effect.succeed(
                  new TokenData({
                    access: "access-token",
                    refresh: "refresh-token",
                    expires: Date.now() + 60_000,
                    accountId: Option.some("account-123"),
                  }),
                ),
                authenticate: Effect.die(
                  new Error("unexpected authenticate call"),
                ),
                logout: Effect.succeed(void 0),
              }),
            ),
          ),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        )

        yield* HttpClientRequest.get("https://example.com/test").pipe(
          HttpClient.execute,
          Effect.provide(layer),
        )

        const request = (yield* Ref.get(requests))[0]
        assert.notStrictEqual(request, undefined)
        if (request === undefined) {
          return
        }

        assert.strictEqual(
          request.headers["authorization"],
          "Bearer access-token",
        )
        assert.strictEqual(request.headers["chatgpt-account-id"], "account-123")
      }),
  )

  it.effect("provides OpenAiClient and LanguageModel through Codex.layer", () =>
    Effect.gen(function* () {
      const accessToken = createTestJwt({ chatgpt_account_id: "account-123" })
      const { attempts, client, requests } = yield* makeClient((request) => {
        if (request.url === `${ISSUER}/api/accounts/deviceauth/usercode`) {
          return jsonResponse({
            device_auth_id: "device-auth-id",
            user_code: "ABCD-EFGH",
            interval: "1",
          })
        }

        if (request.url === `${ISSUER}/api/accounts/deviceauth/token`) {
          return jsonResponse({
            authorization_code: "authorization-code",
            code_verifier: "code-verifier",
          })
        }

        if (request.url === `${ISSUER}/oauth/token`) {
          return jsonResponse({
            access_token: accessToken,
            refresh_token: "refresh-token",
            expires_in: 120,
          })
        }

        if (request.url === "https://chatgpt.com/backend-api/codex/responses") {
          return jsonResponse(makeResponse())
        }

        return new Response(null, { status: 500 })
      })

      const program = Effect.gen(function* () {
        const openAi = yield* OpenAiClient.OpenAiClient
        const languageModel = yield* LanguageModel.LanguageModel
        const response = yield* LanguageModel.generateText({ prompt: "test" })

        assert.notStrictEqual(openAi.client, undefined)
        assert.notStrictEqual(languageModel, undefined)

        const metadata = response.content.find(
          (part) => part.type === "response-metadata",
        )
        assert.strictEqual(metadata?.modelId, DEFAULT_MODEL)

        const seenRequests = yield* Ref.get(requests)
        assert.strictEqual(yield* Ref.get(attempts), 4)
        assert.strictEqual(seenRequests.length, 4)
        assert.strictEqual(
          seenRequests[3]?.url,
          "https://chatgpt.com/backend-api/codex/responses",
        )

        const responseRequest = seenRequests[3]
        assert.notStrictEqual(responseRequest, undefined)
        if (responseRequest === undefined) {
          return
        }

        assert.strictEqual(
          responseRequest.headers["authorization"],
          `Bearer ${accessToken}`,
        )
        assert.strictEqual(
          responseRequest.headers["chatgpt-account-id"],
          "account-123",
        )
        assert.strictEqual(seenRequests[0]?.headers["authorization"], undefined)
        assert.strictEqual(
          JSON.parse(getBody(responseRequest)).model,
          DEFAULT_MODEL,
        )
      })

      yield* program.pipe(
        Effect.provide(Codex.layer),
        Effect.provide(KeyValueStore.layerMemory),
        Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
      )
    }),
  )

  it("re-exports the Codex module at the package root", () => {
    assert.strictEqual(PublicApi.Codex.layer, Codex.layer)
    assert.strictEqual(PublicApi.Codex.model, Codex.model)
  })
})

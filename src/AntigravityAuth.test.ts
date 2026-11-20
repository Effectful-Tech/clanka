import { assert, describe, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  HttpClient,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import { AntigravityAuth, TokenData, toTokenStore } from "./AntigravityAuth.ts"
import { OAuthCallback } from "./OAuthCallback.ts"

const json = (request: HttpClientRequest.HttpClientRequest, body: unknown) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    }),
  )

const bodyText = (request: HttpClientRequest.HttpClientRequest) => {
  if (request.body._tag !== "Uint8Array") throw new Error("Expected a body")
  return new TextDecoder().decode(request.body.body)
}

// Google's token endpoint and Cloud Code, for an account with no project yet.
const setup = (callback: OAuthCallback["Service"]) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request)
      if (request.url === "https://oauth2.googleapis.com/token") {
        return json(request, {
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        })
      }
      if (request.url.endsWith(":loadCodeAssist")) {
        return json(request, {
          allowedTiers: [
            { id: "legacy-tier" },
            { id: "free-tier", isDefault: true },
          ],
        })
      }
      return json(request, {
        done: true,
        response: { cloudaicompanionProject: { id: "onboarded-project" } },
      })
    }),
  )
  const layer = AntigravityAuth.layer.pipe(
    Layer.provide([
      Layer.succeed(HttpClient.HttpClient, client),
      Layer.succeed(OAuthCallback, callback),
    ]),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            CLANKA_ANTIGRAVITY_CLIENT_ID: "client-id",
            CLANKA_ANTIGRAVITY_CLIENT_SECRET: "client-secret",
          },
        }),
      ),
    ),
  )
  return { requests, layer }
}

describe("AntigravityAuth", () => {
  it.effect(
    "signs in through the browser and onboards an account without a project",
    () =>
      Effect.gen(function* () {
        const http = setup({
          receive: ({ url, redirectUri }) =>
            Effect.sync(() => {
              assert.strictEqual(
                redirectUri,
                "http://localhost:51121/oauth-callback",
              )
              const state = new URL(url).searchParams.get("state")!
              return new URLSearchParams({ code: "auth-code", state })
            }),
        })
        const token = yield* AntigravityAuth.use((auth) => auth.get).pipe(
          Effect.provide(http.layer),
        )
        assert.deepStrictEqual(
          yield* toTokenStore(yield* KeyValueStore.KeyValueStore).get("token"),
          Option.some(token),
        )

        assert.strictEqual(token.access, "new-access")
        assert.strictEqual(token.refresh, "new-refresh")
        assert.strictEqual(token.project, "onboarded-project")
        const exchange = new URLSearchParams(bodyText(http.requests[0]!))
        assert.strictEqual(exchange.get("grant_type"), "authorization_code")
        assert.strictEqual(exchange.get("code"), "auth-code")
        assert.strictEqual(exchange.get("client_id"), "client-id")
        assert.strictEqual(exchange.get("client_secret"), "client-secret")
        assert.deepStrictEqual(
          http.requests.map((request) => request.url.split("/").at(-1)),
          ["token", "v1internal:loadCodeAssist", "v1internal:onboardUser"],
        )
        assert.strictEqual(
          JSON.parse(bodyText(http.requests[2]!)).tier_id,
          "free-tier",
        )
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )

  it.effect("refreshes an expired token and keeps its project", () =>
    Effect.gen(function* () {
      const http = setup({
        receive: () => Effect.die("A refresh must not sign in again"),
      })
      yield* toTokenStore(yield* KeyValueStore.KeyValueStore)
        .set(
          "token",
          new TokenData({
            access: "old-access",
            refresh: "old-refresh",
            expires: Date.now() - 1000,
            project: "project-1",
          }),
        )
        .pipe(Effect.orDie)
      const token = yield* AntigravityAuth.use((auth) => auth.get).pipe(
        Effect.provide(http.layer),
      )

      assert.strictEqual(token.access, "new-access")
      assert.strictEqual(token.project, "project-1")
      assert.lengthOf(http.requests, 1)
      const refresh = new URLSearchParams(bodyText(http.requests[0]!))
      assert.strictEqual(refresh.get("grant_type"), "refresh_token")
      assert.strictEqual(refresh.get("refresh_token"), "old-refresh")
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )
})

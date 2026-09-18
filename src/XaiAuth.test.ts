import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as TestClock from "effect/testing/TestClock"
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import { DeviceCodeHandler } from "./DeviceCodeHandler.ts"
import { XaiAuth, TokenData, toTokenStore } from "./XaiAuth.ts"

const clientId = "b1a00492-073a-47ea-816f-4c329264a828"
const deviceUrl = "https://auth.x.ai/oauth2/device/code"
const tokenUrl = "https://auth.x.ai/oauth2/token"
const device = {
  device_code: "private-code",
  user_code: "ABCD-EFGH",
  verification_uri: "https://auth.x.ai/activate",
  expires_in: 600,
  interval: 1,
}
const tokens = {
  access_token: "access",
  refresh_token: "refresh",
  expires_in: 3600,
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
const body = (request: HttpClientRequest.HttpClientRequest) => {
  if (request.body._tag !== "Uint8Array")
    throw new Error("Expected encoded request body")
  const text = new TextDecoder().decode(request.body.body)
  return request.headers["content-type"]?.includes("application/json")
    ? JSON.parse(text)
    : Object.fromEntries(new URLSearchParams(text))
}
const setup = Effect.fn(function* (
  respond: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<Response, HttpClientError.HttpClientError>,
) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const codes: Array<{ verifyUrl: string; deviceCode: string }> = []
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      requests.push(request)
      return HttpClientResponse.fromWeb(request, yield* respond(request))
    }),
  )
  const auth = yield* XaiAuth.make.pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(DeviceCodeHandler, {
      onCode: (code) =>
        Effect.sync(() => {
          codes.push(code)
        }),
    }),
  )
  return { auth, requests, codes }
})
const seed = Effect.fn(function* (expires: number) {
  const store = toTokenStore(yield* KeyValueStore.KeyValueStore)
  yield* store
    .set(
      "token",
      new TokenData({ access: "old-access", refresh: "old-refresh", expires }),
    )
    .pipe(Effect.orDie)
})

describe("XaiAuth", () => {
  for (const refresh of [false, true]) {
    it.effect(
      "defaults omitted token expiry to one hour during " +
        (refresh ? "refresh" : "login"),
      () =>
        Effect.gen(function* () {
          if (refresh) yield* seed(1)
          const { auth, requests, codes } = yield* setup((request) =>
            Effect.succeed(
              json(
                request.url === deviceUrl
                  ? device
                  : {
                      access_token: tokens.access_token,
                      refresh_token: tokens.refresh_token,
                    },
              ),
            ),
          )
          const before = Date.now()
          const token = yield* auth.get
          assert.strictEqual(token.access, "access")
          assert.strictEqual(token.refresh, "refresh")
          assert.isAtLeast(token.expires, before + 3600000)
          assert.isAtMost(token.expires, Date.now() + 3600000)
          const stored = yield* toTokenStore(yield* KeyValueStore.KeyValueStore)
            .get("token")
            .pipe(Effect.orDie)
          assert.deepStrictEqual(Option.getOrThrow(stored), token)
          yield* auth.get
          assert.lengthOf(requests, refresh ? 1 : 2)
          assert.lengthOf(codes, refresh ? 0 : 1)
        }).pipe(Effect.provide(KeyValueStore.layerMemory)),
    )
  }

  it.effect(
    "preserves and persists the existing refresh token when rotation is omitted",
    () =>
      Effect.gen(function* () {
        yield* seed(1)
        const { auth, requests, codes } = yield* setup((request) =>
          Effect.succeed(
            json(
              request.url === deviceUrl
                ? device
                : {
                    access_token: "access",
                    expires_in: 3600,
                  },
            ),
          ),
        )
        const token = yield* auth.get
        assert.strictEqual(token.access, "access")
        assert.strictEqual(token.refresh, "old-refresh")
        assert.lengthOf(requests, 1)
        assert.strictEqual(body(requests[0]!).refresh_token, "old-refresh")
        assert.lengthOf(codes, 0)
        const stored = yield* toTokenStore(yield* KeyValueStore.KeyValueStore)
          .get("token")
          .pipe(Effect.orDie)
        assert.deepStrictEqual(Option.getOrThrow(stored), token)
        yield* auth.get
        assert.lengthOf(requests, 1)
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )

  it.effect(
    "accepts an initial login without a refresh token and persists an empty fallback",
    () =>
      Effect.gen(function* () {
        const { auth, requests } = yield* setup((request) =>
          Effect.succeed(
            json(
              request.url === deviceUrl
                ? device
                : {
                    access_token: "access",
                    expires_in: 3600,
                  },
            ),
          ),
        )
        const token = yield* auth.get
        assert.strictEqual(token.access, "access")
        assert.strictEqual(token.refresh, "")
        assert.isFalse(token.isExpired())
        const stored = yield* toTokenStore(yield* KeyValueStore.KeyValueStore)
          .get("token")
          .pipe(Effect.orDie)
        assert.deepStrictEqual(Option.getOrThrow(stored), token)
        yield* auth.get
        assert.lengthOf(requests, 2)
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )

  for (const expires of [0, -1]) {
    it.effect("uses a fallback lifetime for device expiry " + expires, () =>
      Effect.gen(function* () {
        let polls = 0
        const { auth, requests } = yield* setup((request) =>
          Effect.sync(() => {
            if (request.url === deviceUrl)
              return json({ ...device, expires_in: expires })
            return ++polls === 1
              ? json({ error: "authorization_pending" }, 400)
              : json(tokens)
          }),
        )
        const fiber = yield* auth.get.pipe(
          Effect.forkChild({ startImmediately: true }),
        )
        yield* TestClock.adjust(4000)
        assert.strictEqual((yield* Fiber.join(fiber)).access, "access")
        assert.strictEqual(polls, 2)
        assert.lengthOf(requests, 3)
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
    )
  }

  for (const refresh of [false, true]) {
    for (const transient of ["transport", "502"] as const) {
      it.effect(
        "recovers from transient " +
          transient +
          " during " +
          (refresh ? "refresh" : "polling"),
        () =>
          Effect.gen(function* () {
            if (refresh) yield* seed(1)
            let attempts = 0
            const { auth, requests, codes } = yield* setup((request) =>
              Effect.gen(function* () {
                if (request.url === deviceUrl) return json(device)
                attempts++
                if (attempts === 1) {
                  if (transient === "502")
                    return new Response("Bad Gateway", { status: 502 })
                  return yield* new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      cause: new Error("Connection reset"),
                    }),
                  })
                }
                // An OAuth 400 after recovery must still reach the polling state machine.
                if (!refresh && attempts === 2)
                  return json({ error: "authorization_pending" }, 400)
                return json(tokens)
              }),
            )
            const fiber = yield* auth.get.pipe(
              Effect.forkChild({ startImmediately: true }),
            )
            yield* TestClock.adjust("1 minute")
            const token = yield* Fiber.join(fiber)
            assert.strictEqual(token.access, "access")
            assert.strictEqual(attempts, refresh ? 2 : 3)
            assert.lengthOf(codes, refresh ? 0 : 1)
            assert.deepStrictEqual(
              requests.map((request) => request.url),
              refresh
                ? [tokenUrl, tokenUrl]
                : [deviceUrl, tokenUrl, tokenUrl, tokenUrl],
            )
            for (const request of requests.filter(
              (request) => request.url === tokenUrl,
            )) {
              assert.strictEqual(
                body(request).grant_type,
                refresh
                  ? "refresh_token"
                  : "urn:ietf:params:oauth:grant-type:device_code",
              )
            }
            const stored = yield* toTokenStore(
              yield* KeyValueStore.KeyValueStore,
            )
              .get("token")
              .pipe(Effect.orDie)
            assert.deepStrictEqual(Option.getOrThrow(stored), token)
          }).pipe(Effect.provide(KeyValueStore.layerMemory)),
      )
    }
  }

  it("treats zero and near-expiry tokens as expired, unlike Copilot", () => {
    for (const expires of [0, Date.now() - 1000, Date.now() + 1000]) {
      assert.isTrue(
        new TokenData({ access: "a", refresh: "r", expires }).isExpired(),
      )
    }
    assert.isFalse(
      new TokenData({
        access: "a",
        refresh: "r",
        expires: Date.now() + 3600000,
      }).isExpired(),
    )
  })

  it.effect(
    "logs in lazily, sends the public client and scope, and persists expiring credentials",
    () =>
      Effect.gen(function* () {
        const { auth, requests, codes } = yield* setup((request) =>
          Effect.succeed(json(request.url === deviceUrl ? device : tokens)),
        )
        assert.lengthOf(requests, 0)
        assert.lengthOf(codes, 0)
        const before = Date.now()
        const token = yield* auth.get
        assert.strictEqual(token.access, "access")
        assert.strictEqual(token.refresh, "refresh")
        assert.isAtLeast(token.expires, before + 3600000)
        assert.isAtMost(token.expires, Date.now() + 3600000)
        assert.deepStrictEqual(codes, [
          { verifyUrl: device.verification_uri, deviceCode: device.user_code },
        ])
        assert.deepStrictEqual(
          requests.map((r) => [r.method, r.url]),
          [
            ["POST", deviceUrl],
            ["POST", tokenUrl],
          ],
        )
        assert.deepInclude(body(requests[0]!), {
          client_id: clientId,
          scope:
            "openid profile email offline_access grok-cli:access api:access",
          referrer: "clanka",
        })
        assert.deepInclude(body(requests[1]!), {
          client_id: clientId,
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        })
        for (const request of requests) {
          assert.match(request.headers["user-agent"]!, /clanka/i)
          assert.notMatch(request.headers["user-agent"]!, /opencode/i)
          assert.isUndefined(request.headers.authorization)
        }
        const kvs = yield* KeyValueStore.KeyValueStore
        const raw = yield* kvs.get("xai.auth/token").pipe(Effect.orDie)
        assert.deepInclude(JSON.parse(raw!), {
          access: "access",
          refresh: "refresh",
          expires: token.expires,
        })
        assert.isUndefined(yield* kvs.get("token").pipe(Effect.orDie))
        yield* auth.get
        assert.lengthOf(requests, 2)
        yield* auth.logout
        assert.isUndefined(yield* kvs.get("xai.auth/token").pipe(Effect.orDie))
        yield* auth.get
        assert.lengthOf(requests, 4)
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )

  it.effect("reuses valid persisted credentials without login or refresh", () =>
    Effect.gen(function* () {
      yield* seed(Date.now() + 3600000)
      const { auth, requests, codes } = yield* setup(() =>
        Effect.die("Unexpected HTTP request"),
      )
      assert.strictEqual((yield* auth.get).access, "old-access")
      assert.lengthOf(requests, 0)
      assert.lengthOf(codes, 0)
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )

  for (const expires of [0, 1]) {
    it.effect(
      "refreshes expired credentials (expires=" +
        expires +
        ") and persists rotation",
      () =>
        Effect.gen(function* () {
          yield* seed(expires)
          const { auth, requests, codes } = yield* setup(() =>
            Effect.succeed(json(tokens)),
          )
          const token = yield* auth.get
          assert.strictEqual(token.access, "access")
          assert.strictEqual(token.refresh, "refresh")
          assert.isAbove(token.expires, Date.now() + 3500000)
          assert.lengthOf(requests, 1)
          assert.strictEqual(requests[0]!.url, tokenUrl)
          assert.deepInclude(body(requests[0]!), {
            client_id: clientId,
            grant_type: "refresh_token",
            refresh_token: "old-refresh",
          })
          assert.lengthOf(codes, 0)
          const stored = yield* toTokenStore(yield* KeyValueStore.KeyValueStore)
            .get("token")
            .pipe(Effect.orDie)
          assert.deepStrictEqual(Option.getOrThrow(stored), token)
          yield* auth.get
          assert.lengthOf(requests, 1)
        }).pipe(Effect.provide(KeyValueStore.layerMemory)),
    )
  }

  it.effect("falls back to device login after a rejected refresh", () =>
    Effect.gen(function* () {
      yield* seed(1)
      const { auth, requests, codes } = yield* setup((request) =>
        Effect.succeed(
          json(
            request.url === deviceUrl
              ? device
              : body(request).grant_type === "refresh_token"
                ? { error: "invalid_grant" }
                : tokens,
            request.url === tokenUrl &&
              body(request).grant_type === "refresh_token"
              ? 400
              : 200,
          ),
        ),
      )
      assert.strictEqual((yield* auth.get).access, "access")
      assert.deepStrictEqual(
        requests.map((r) => r.url),
        [tokenUrl, deviceUrl, tokenUrl],
      )
      assert.lengthOf(codes, 1)
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )

  it.effect(
    "waits on authorization_pending and increases the delay on slow_down",
    () =>
      Effect.gen(function* () {
        let polls = 0
        const { auth } = yield* setup((request) =>
          Effect.sync(() => {
            if (request.url === deviceUrl) return json(device)
            polls++
            return polls === 1
              ? json({ error: "authorization_pending" }, 400)
              : polls === 2
                ? json({ error: "slow_down", interval: 1 }, 400)
                : json(tokens)
          }),
        )
        const fiber = yield* auth.get.pipe(
          Effect.forkChild({ startImmediately: true }),
        )
        yield* TestClock.adjust(3999)
        assert.strictEqual(polls, 1)
        yield* TestClock.adjust(1)
        assert.strictEqual(polls, 2)
        yield* TestClock.adjust(8999)
        assert.strictEqual(polls, 2)
        yield* TestClock.adjust(1)
        assert.strictEqual((yield* Fiber.join(fiber)).access, "access")
        assert.strictEqual(polls, 3)
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )

  for (const error of ["access_denied", "expired_token"]) {
    it.effect("stops polling on " + error + " without storing a token", () =>
      Effect.gen(function* () {
        const { auth, requests } = yield* setup((request) =>
          Effect.succeed(
            request.url === deviceUrl ? json(device) : json({ error }, 400),
          ),
        )
        const failure = yield* auth.get.pipe(Effect.flip)
        assert.include(failure.message, error)
        assert.lengthOf(requests, 2)
        const stored = yield* toTokenStore(yield* KeyValueStore.KeyValueStore)
          .get("token")
          .pipe(Effect.orDie)
        assert.isTrue(Option.isNone(stored))
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
    )
  }

  for (const refresh of [false, true]) {
    it.effect(
      "serializes concurrent " + (refresh ? "refresh" : "login") + " requests",
      () =>
        Effect.gen(function* () {
          if (refresh) yield* seed(1)
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const { auth, requests } = yield* setup((request) =>
            request.url === deviceUrl
              ? Effect.succeed(json(device))
              : Effect.gen(function* () {
                  yield* Deferred.succeed(started, undefined)
                  yield* Deferred.await(release)
                  return json(tokens)
                }),
          )
          const first = yield* auth.get.pipe(
            Effect.forkChild({ startImmediately: true }),
          )
          yield* Deferred.await(started)
          const second = yield* auth.get.pipe(
            Effect.forkChild({ startImmediately: true }),
          )
          yield* Effect.yieldNow
          assert.lengthOf(requests, refresh ? 1 : 2)
          yield* Deferred.succeed(release, undefined)
          assert.strictEqual((yield* Fiber.join(first)).access, "access")
          assert.strictEqual((yield* Fiber.join(second)).access, "access")
          assert.lengthOf(requests, refresh ? 1 : 2)
        }).pipe(Effect.provide(KeyValueStore.layerMemory)),
    )
  }
})

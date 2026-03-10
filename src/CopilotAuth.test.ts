import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option, Ref } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { KeyValueStore } from "effect/unstable/persistence"
import {
  COPILOT_VISION_REQUEST_HEADER,
  DEFAULT_OPENAI_INTENT,
  DEFAULT_USER_AGENT,
  GithubCopilotAuth,
  GithubCopilotAuthError,
  INITIATOR_HEADER,
  ISSUER,
  OPENAI_INTENT_HEADER,
  STORE_PREFIX,
  STORE_TOKEN_KEY,
  TokenData,
  toGithubCopilotAuthKeyValueStore,
  toTokenStore,
} from "./CopilotAuth.ts"

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

const makeEffectClient = Effect.fn("makeEffectClient")(function* (
  handler: (
    request: HttpClientRequest.HttpClientRequest,
    attempt: number,
  ) => Effect.Effect<Response>,
) {
  const attempts = yield* Ref.make(0)
  const requests = yield* Ref.make<Array<HttpClientRequest.HttpClientRequest>>(
    [],
  )
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1)
      yield* Ref.update(requests, (current) => [...current, request])
      return HttpClientResponse.fromWeb(
        request,
        yield* handler(request, attempt),
      )
    }),
  )

  return {
    attempts,
    client,
    requests,
  } as const
})

describe("GithubCopilotAuth", () => {
  it.effect(
    "persists token data through the prefixed schema store",
    Effect.fn(function* () {
      const kvs = yield* KeyValueStore.KeyValueStore
      const tokenStore = toTokenStore(kvs)
      const token = new TokenData({
        access: "copilot-access-token",
        expires: 0,
      })

      yield* Effect.orDie(tokenStore.set(STORE_TOKEN_KEY, token))

      const stored = yield* Effect.orDie(tokenStore.get(STORE_TOKEN_KEY))

      assert.strictEqual(Option.isSome(stored), true)
      if (Option.isNone(stored)) {
        return
      }

      assert.strictEqual(stored.value.access, token.access)
      assert.strictEqual(stored.value.expires, token.expires)

      const rawValue = yield* Effect.orDie(
        kvs.get(`${STORE_PREFIX}${STORE_TOKEN_KEY}`),
      )
      const unprefixedValue = yield* Effect.orDie(kvs.get(STORE_TOKEN_KEY))

      assert.strictEqual(typeof rawValue, "string")
      assert.strictEqual(unprefixedValue, undefined)
    }, Effect.provide(KeyValueStore.layerMemory)),
  )

  it("treats expires=0 as non-expiring", () => {
    const nonExpiring = new TokenData({
      access: "copilot-access-token",
      expires: 0,
    })
    const expired = new TokenData({
      access: "copilot-access-token",
      expires: Date.now() - 1_000,
    })
    const valid = new TokenData({
      access: "copilot-access-token",
      expires: Date.now() + 60_000,
    })

    assert.strictEqual(nonExpiring.isExpired(), false)
    assert.strictEqual(expired.isExpired(), true)
    assert.strictEqual(valid.isExpired(), false)
  })

  it("constructs GithubCopilotAuthError with the expected tagged shape", () => {
    const error = new GithubCopilotAuthError({
      reason: "DeviceFlowFailed",
      message: "Could not authenticate with GitHub Copilot",
    })

    assert.strictEqual(error._tag, "GithubCopilotAuthError")
    assert.strictEqual(error.reason, "DeviceFlowFailed")
    assert.strictEqual(
      error.message,
      "Could not authenticate with GitHub Copilot",
    )
  })

  it.effect("returns a cached token without performing any requests", () =>
    Effect.gen(function* () {
      const kvs = yield* KeyValueStore.KeyValueStore
      const tokenStore = toTokenStore(kvs)
      yield* Effect.orDie(
        tokenStore.set(
          STORE_TOKEN_KEY,
          new TokenData({
            access: "cached-copilot-token",
            expires: 0,
          }),
        ),
      )

      const { attempts, client } = yield* makeClient(
        () => new Response(null, { status: 500 }),
      )

      const auth = yield* GithubCopilotAuth.make.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      )

      const token = yield* auth.get

      assert.strictEqual(token.access, "cached-copilot-token")
      assert.strictEqual(yield* Ref.get(attempts), 0)
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )

  it.effect(
    "authenticates, persists the token, and clears memory plus storage on logout",
    () =>
      Effect.gen(function* () {
        const kvs = yield* KeyValueStore.KeyValueStore
        const tokenStore = toTokenStore(kvs)

        let authCount = 0
        const { attempts, client, requests } = yield* makeClient((request) => {
          if (request.url === `${ISSUER}/login/device/code`) {
            authCount += 1
            return jsonResponse({
              device_code: `device-code-${authCount}`,
              user_code: `USER-${authCount}`,
              verification_uri: `${ISSUER}/login/device`,
              interval: 1,
            })
          }

          if (request.url === `${ISSUER}/login/oauth/access_token`) {
            return jsonResponse({
              access_token: `copilot-token-${authCount}`,
            })
          }

          return new Response(null, { status: 500 })
        })

        const auth = yield* GithubCopilotAuth.make.pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        )

        const authenticated = yield* auth.authenticate
        assert.strictEqual(authenticated.access, "copilot-token-1")
        assert.strictEqual(yield* Ref.get(attempts), 2)

        const stored = yield* Effect.orDie(tokenStore.get(STORE_TOKEN_KEY))
        assert.strictEqual(Option.isSome(stored), true)
        if (Option.isSome(stored)) {
          assert.strictEqual(stored.value.access, "copilot-token-1")
        }

        yield* auth.logout
        const storedAfterLogout = yield* Effect.orDie(
          tokenStore.get(STORE_TOKEN_KEY),
        )
        assert.strictEqual(Option.isNone(storedAfterLogout), true)

        const tokenAfterLogout = yield* auth.get
        assert.strictEqual(tokenAfterLogout.access, "copilot-token-2")
        assert.strictEqual(yield* Ref.get(attempts), 4)

        const seenRequests = yield* Ref.get(requests)
        assert.strictEqual(seenRequests.length, 4)
        assert.strictEqual(seenRequests[0]?.url, `${ISSUER}/login/device/code`)
        assert.strictEqual(
          getBody(seenRequests[0]!).includes(
            `"client_id":"Ov23li8tweQw6odWQebz"`,
          ),
          true,
        )
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )

  it.effect("clears corrupted persisted tokens before re-authenticating", () =>
    Effect.gen(function* () {
      const kvs = yield* KeyValueStore.KeyValueStore
      yield* Effect.orDie(
        kvs.set(`${STORE_PREFIX}${STORE_TOKEN_KEY}`, "not-json"),
      )

      const { attempts, client } = yield* makeClient((request) => {
        if (request.url === `${ISSUER}/login/device/code`) {
          return jsonResponse({
            device_code: "device-code",
            user_code: "ABCD-EFGH",
            verification_uri: `${ISSUER}/login/device`,
            interval: 1,
          })
        }

        if (request.url === `${ISSUER}/login/oauth/access_token`) {
          return jsonResponse({
            access_token: "fresh-copilot-token",
          })
        }

        return new Response(null, { status: 500 })
      })

      const auth = yield* GithubCopilotAuth.make.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      )

      assert.strictEqual(
        yield* Effect.orDie(kvs.get(`${STORE_PREFIX}${STORE_TOKEN_KEY}`)),
        undefined,
      )
      assert.strictEqual(yield* Ref.get(attempts), 0)

      const token = yield* auth.get

      assert.strictEqual(token.access, "fresh-copilot-token")
      assert.strictEqual(yield* Ref.get(attempts), 2)
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )

  it.effect("serializes concurrent get calls behind one authentication", () =>
    Effect.gen(function* () {
      const authStarted = yield* Deferred.make<void>()
      const releaseAuth = yield* Deferred.make<void>()
      const { attempts, client } = yield* makeEffectClient((request) => {
        if (request.url === `${ISSUER}/login/device/code`) {
          return Effect.succeed(
            jsonResponse({
              device_code: "device-code",
              user_code: "ABCD-EFGH",
              verification_uri: `${ISSUER}/login/device`,
              interval: 1,
            }),
          )
        }

        if (request.url === `${ISSUER}/login/oauth/access_token`) {
          return Effect.gen(function* () {
            yield* Deferred.succeed(authStarted, void 0)
            yield* Deferred.await(releaseAuth)
            return jsonResponse({
              access_token: "shared-copilot-token",
            })
          })
        }

        return Effect.succeed(new Response(null, { status: 500 }))
      })

      const auth = yield* GithubCopilotAuth.make.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      )

      const firstFiber = yield* auth.get.pipe(
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(authStarted)

      const secondFiber = yield* auth.get.pipe(
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Effect.yieldNow

      assert.strictEqual(yield* Ref.get(attempts), 2)

      yield* Deferred.succeed(releaseAuth, void 0)

      const first = yield* Fiber.join(firstFiber)
      const second = yield* Fiber.join(secondFiber)

      assert.strictEqual(yield* Ref.get(attempts), 2)
      assert.strictEqual(first.access, "shared-copilot-token")
      assert.strictEqual(second.access, "shared-copilot-token")
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )

  it.effect(
    "injects Copilot auth and request metadata headers through the client layer",
    () =>
      Effect.gen(function* () {
        const kvs = yield* KeyValueStore.KeyValueStore
        const tokenStore = toTokenStore(kvs)
        yield* Effect.orDie(
          tokenStore.set(
            STORE_TOKEN_KEY,
            new TokenData({
              access: "copilot-token",
              expires: 0,
            }),
          ),
        )

        const { client, requests } = yield* makeClient(() =>
          jsonResponse({ ok: true }),
        )

        const wrappedClient = yield* Effect.gen(function* () {
          return yield* HttpClient.HttpClient
        }).pipe(
          Effect.provide(GithubCopilotAuth.layerClientNoDeps),
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(
            GithubCopilotAuth,
            yield* GithubCopilotAuth.make.pipe(
              Effect.provideService(HttpClient.HttpClient, client),
            ),
          ),
        )

        yield* HttpClientRequest.post(
          "https://api.githubcopilot.com/chat/completions",
        ).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            model: "gpt-4.1",
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "describe this image",
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: "https://example.com/image.png",
                    },
                  },
                ],
              },
            ],
          }),
          wrappedClient.execute,
        )

        yield* HttpClientRequest.post(
          "https://api.githubcopilot.com/chat/completions",
        ).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            model: "gpt-4.1",
            messages: [
              {
                role: "assistant",
                content: "running tools",
              },
            ],
          }),
          wrappedClient.execute,
        )

        const seenRequests = yield* Ref.get(requests)
        const visionRequest = seenRequests[0]!
        const agentRequest = seenRequests[1]!

        assert.strictEqual(
          visionRequest.headers.authorization,
          "Bearer copilot-token",
        )
        assert.strictEqual(
          visionRequest.headers["user-agent"],
          DEFAULT_USER_AGENT,
        )
        assert.strictEqual(
          visionRequest.headers[OPENAI_INTENT_HEADER.toLowerCase()],
          DEFAULT_OPENAI_INTENT,
        )
        assert.strictEqual(visionRequest.headers[INITIATOR_HEADER], "user")
        assert.strictEqual(
          visionRequest.headers[COPILOT_VISION_REQUEST_HEADER.toLowerCase()],
          "true",
        )
        assert.strictEqual(agentRequest.headers[INITIATOR_HEADER], "agent")
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  )

  it.effect(
    "exposes the prefixed store helper",
    Effect.fn(function* () {
      const kvs = yield* KeyValueStore.KeyValueStore
      const prefixedStore = toGithubCopilotAuthKeyValueStore(kvs)

      yield* Effect.orDie(prefixedStore.set(STORE_TOKEN_KEY, "raw-token"))

      assert.strictEqual(
        yield* Effect.orDie(kvs.get(`${STORE_PREFIX}${STORE_TOKEN_KEY}`)),
        "raw-token",
      )
      assert.strictEqual(
        yield* Effect.orDie(kvs.get(STORE_TOKEN_KEY)),
        undefined,
      )
    }, Effect.provide(KeyValueStore.layerMemory)),
  )
})

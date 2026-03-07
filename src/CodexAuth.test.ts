import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import {
  CLIENT_ID,
  CodexAuthError,
  CODEX_API_BASE,
  ISSUER,
  POLLING_SAFETY_MARGIN_MS,
  STORE_PREFIX,
  STORE_TOKEN_KEY,
  TOKEN_EXPIRY_BUFFER_MS,
  TokenData,
  toCodexAuthKeyValueStore,
  toTokenStore,
} from "./CodexAuth.ts"
import * as PublicApi from "./index.ts"

describe("CodexAuth", () => {
  it.effect(
    "persists token data through the prefixed schema store",
    Effect.fn(function* () {
      const kvs = yield* KeyValueStore.KeyValueStore
      const tokenStore = toTokenStore(kvs)
      const token = new TokenData({
        access: "access-token",
        refresh: "refresh-token",
        expires: 1_700_000_000_000,
        accountId: Option.some("account_123"),
      })

      yield* Effect.orDie(tokenStore.set(STORE_TOKEN_KEY, token))

      const stored = yield* Effect.orDie(tokenStore.get(STORE_TOKEN_KEY))

      assert.strictEqual(Option.isSome(stored), true)
      if (Option.isNone(stored)) {
        return
      }

      assert.strictEqual(stored.value.access, token.access)
      assert.strictEqual(stored.value.refresh, token.refresh)
      assert.strictEqual(stored.value.expires, token.expires)
      assert.strictEqual(Option.isSome(stored.value.accountId), true)
      if (Option.isSome(stored.value.accountId)) {
        assert.strictEqual(stored.value.accountId.value, "account_123")
      }

      const rawValue = yield* Effect.orDie(
        kvs.get(`${STORE_PREFIX}${STORE_TOKEN_KEY}`),
      )
      const unprefixedValue = yield* Effect.orDie(kvs.get(STORE_TOKEN_KEY))

      assert.strictEqual(typeof rawValue, "string")
      assert.strictEqual(unprefixedValue, undefined)
    }, Effect.provide(KeyValueStore.layerMemory)),
  )

  it.effect(
    "round-trips missing account ids as Option.none",
    Effect.fn(function* () {
      const kvs = yield* KeyValueStore.KeyValueStore
      const prefixedStore = toCodexAuthKeyValueStore(kvs)
      const tokenStore = toTokenStore(kvs)
      const token = new TokenData({
        access: "access-token",
        refresh: "refresh-token",
        expires: 1_700_000_000_000,
        accountId: Option.none(),
      })

      yield* Effect.orDie(tokenStore.set(STORE_TOKEN_KEY, token))

      const stored = yield* Effect.orDie(tokenStore.get(STORE_TOKEN_KEY))

      assert.strictEqual(Option.isSome(stored), true)
      if (Option.isNone(stored)) {
        return
      }

      assert.strictEqual(Option.isNone(stored.value.accountId), true)
      assert.strictEqual(
        yield* Effect.orDie(prefixedStore.has(STORE_TOKEN_KEY)),
        true,
      )
    }, Effect.provide(KeyValueStore.layerMemory)),
  )

  it("marks tokens expired using the refresh buffer", () => {
    const now = Date.now()
    const expiredSoon = new TokenData({
      access: "access-token",
      refresh: "refresh-token",
      expires: now + TOKEN_EXPIRY_BUFFER_MS - 1_000,
      accountId: Option.none(),
    })
    const stillValid = new TokenData({
      access: "access-token",
      refresh: "refresh-token",
      expires: now + TOKEN_EXPIRY_BUFFER_MS + 60_000,
      accountId: Option.none(),
    })

    assert.strictEqual(expiredSoon.isExpired(), true)
    assert.strictEqual(stillValid.isExpired(), false)
  })

  it("constructs CodexAuthError with the expected tagged shape", () => {
    const error = new CodexAuthError({
      reason: "JwtParseFailed",
      message: "Could not decode token claims",
    })

    assert.strictEqual(error._tag, "CodexAuthError")
    assert.strictEqual(error.reason, "JwtParseFailed")
    assert.strictEqual(error.message, "Could not decode token claims")
  })

  it("re-exports the public Codex auth surface without storage helpers", () => {
    assert.strictEqual(PublicApi.CLIENT_ID, CLIENT_ID)
    assert.strictEqual(PublicApi.CODEX_API_BASE, CODEX_API_BASE)
    assert.strictEqual(PublicApi.ISSUER, ISSUER)
    assert.strictEqual(
      PublicApi.POLLING_SAFETY_MARGIN_MS,
      POLLING_SAFETY_MARGIN_MS,
    )
    assert.strictEqual(PublicApi.STORE_PREFIX, STORE_PREFIX)
    assert.strictEqual(PublicApi.STORE_TOKEN_KEY, STORE_TOKEN_KEY)
    assert.strictEqual(PublicApi.TOKEN_EXPIRY_BUFFER_MS, TOKEN_EXPIRY_BUFFER_MS)
    assert.strictEqual(PublicApi.TokenData, TokenData)
    assert.strictEqual(PublicApi.CodexAuthError, CodexAuthError)
    assert.strictEqual("toCodexAuthKeyValueStore" in PublicApi, false)
    assert.strictEqual("toTokenStore" in PublicApi, false)
  })
})

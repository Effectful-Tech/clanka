import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Option from "effect/Option"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import {
  CodexAuthError,
  STORE_PREFIX,
  STORE_TOKEN_KEY,
  TOKEN_EXPIRY_BUFFER_MS,
  TokenData,
  extractAccountIdFromClaims,
  extractAccountIdFromToken,
  parseJwtClaims,
  toCodexAuthKeyValueStore,
  toTokenStore,
} from "./CodexAuth.ts"

const createJwt = (payload: string): string =>
  `${Encoding.encodeBase64Url(JSON.stringify({ alg: "none" }))}.${Encoding.encodeBase64Url(payload)}.sig`

const createTestJwt = (payload: Record<string, unknown>): string =>
  createJwt(JSON.stringify(payload))

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
      reason: "RefreshFailed",
      message: "Could not refresh the token",
    })

    assert.strictEqual(error._tag, "CodexAuthError")
    assert.strictEqual(error.reason, "RefreshFailed")
    assert.strictEqual(error.message, "Could not refresh the token")
  })

  it("parses valid JWT claims from a base64url payload", () => {
    assert.deepStrictEqual(
      Option.getOrUndefined(
        parseJwtClaims(
          createTestJwt({
            email: "test@example.com",
            chatgpt_account_id: "acc-123",
          }),
        ),
      ),
      {
        chatgpt_account_id: "acc-123",
      },
    )
  })

  it("returns none for JWTs without three parts", () => {
    assert.strictEqual(Option.isNone(parseJwtClaims("invalid")), true)
    assert.strictEqual(Option.isNone(parseJwtClaims("only.two")), true)
  })

  it("returns none for invalid base64url payloads", () => {
    assert.strictEqual(Option.isNone(parseJwtClaims("a.!!!invalid!!!.b")), true)
  })

  it("returns none for invalid JSON payloads", () => {
    assert.strictEqual(
      Option.isNone(parseJwtClaims(createJwt("not json"))),
      true,
    )
  })

  it("ignores malformed claim types instead of failing the parse", () => {
    assert.deepStrictEqual(
      Option.getOrUndefined(
        parseJwtClaims(createTestJwt({ chatgpt_account_id: 123 })),
      ),
      {},
    )
  })

  it("keeps valid account ids when other claim locations are malformed", () => {
    assert.strictEqual(
      Option.getOrUndefined(
        extractAccountIdFromToken(
          createTestJwt({
            chatgpt_account_id: "acc-root",
            "https://api.openai.com/auth": "invalid",
          }),
        ),
      ),
      "acc-root",
    )
    assert.strictEqual(
      Option.getOrUndefined(
        extractAccountIdFromToken(
          createTestJwt({
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acc-nested",
            },
            organizations: [123],
          }),
        ),
      ),
      "acc-nested",
    )
  })

  it("extracts account ids from the documented claim locations", () => {
    assert.strictEqual(
      Option.getOrUndefined(
        extractAccountIdFromClaims({ chatgpt_account_id: "acc-root" }),
      ),
      "acc-root",
    )
    assert.strictEqual(
      Option.getOrUndefined(
        extractAccountIdFromClaims({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acc-nested",
          },
        }),
      ),
      "acc-nested",
    )
    assert.strictEqual(
      Option.getOrUndefined(
        extractAccountIdFromClaims({
          organizations: [{ id: "org-123" }, { id: "org-456" }],
        }),
      ),
      "org-123",
    )
  })

  it("prefers root claims over nested and organization fallbacks", () => {
    assert.strictEqual(
      Option.getOrUndefined(
        extractAccountIdFromClaims({
          chatgpt_account_id: "acc-root",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acc-nested",
          },
          organizations: [{ id: "org-123" }],
        }),
      ),
      "acc-root",
    )
  })

  it("treats empty root and nested account ids as missing", () => {
    assert.strictEqual(
      Option.getOrUndefined(
        extractAccountIdFromClaims({
          chatgpt_account_id: "",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acc-nested",
          },
        }),
      ),
      "acc-nested",
    )
    assert.strictEqual(
      Option.getOrUndefined(
        extractAccountIdFromClaims({
          chatgpt_account_id: "",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "",
          },
          organizations: [{ id: "org-123" }],
        }),
      ),
      "org-123",
    )
  })

  it("treats empty organization ids as missing", () => {
    assert.strictEqual(
      Option.isNone(
        extractAccountIdFromClaims({
          organizations: [{ id: "" }],
        }),
      ),
      true,
    )
  })

  it("returns none when no account id claim is present", () => {
    assert.strictEqual(
      Option.isNone(
        extractAccountIdFromClaims({
          organizations: [],
        }),
      ),
      true,
    )
  })

  it("extracts account ids directly from JWTs", () => {
    assert.strictEqual(
      Option.getOrUndefined(
        extractAccountIdFromToken(
          createTestJwt({
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acc-token",
            },
          }),
        ),
      ),
      "acc-token",
    )
    assert.strictEqual(
      Option.isNone(extractAccountIdFromToken("invalid")),
      true,
    )
  })
})

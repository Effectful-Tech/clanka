# OpenAI Codex Auth Specification

Integrate OpenAI Codex provider auth with `@effect/ai-openai` using OpenAI's
headless device authorization flow and Effect-native services/layers.

## Overview

This plan integrates OpenAI Codex auth in a way that is:

- Compatible with `@effect/ai-openai` (Responses API provider)
- Aligned with opencode's OpenAI/Codex auth behavior
- Implemented with Effect patterns already used in `.repos/lalph`

The integration stores OAuth tokens in `KeyValueStore`, auto-refreshes tokens,
and exposes a ready-to-use `LanguageModel` layer backed by the Codex endpoint
(`https://chatgpt.com/backend-api/codex/responses`).

## Scope (Confirmed)

- Auth method: **headless device flow only**
- Endpoint: **Codex endpoint only** (no standard OpenAI API endpoint switching)
- Storage: **Effect `KeyValueStore`**
- Expiry handling: **automatic refresh**
- Surface area: **full stack** (`OpenAiClient` + `OpenAiLanguageModel` +
  compatibility with `Chat` / `Tool` / `Toolkit`)
- Auth abstraction: **OpenAI-specific** for now

## Research Summary

### opencode OpenAI Provider Findings

- opencode direct OpenAI provider supports API-key and OAuth-based auth; for
  Codex OAuth it uses OpenAI auth endpoints with device flow.
- Headless flow endpoints:
  - `POST https://auth.openai.com/api/accounts/deviceauth/usercode`
  - `POST https://auth.openai.com/api/accounts/deviceauth/token`
  - `POST https://auth.openai.com/oauth/token`
- Device poll semantics in opencode:
  - `200` -> authorization ready
  - `403` / `404` -> authorization pending
  - anything else -> failure
- opencode computes token expiry as
  `Date.now() + (expires_in ?? 3600) * 1000`
- account ID extraction checks three claim locations:
  - `chatgpt_account_id`
  - `claims["https://api.openai.com/auth"]?.chatgpt_account_id`
  - `organizations[0].id`

### `@effect/ai-openai` Findings

- Uses OpenAI Responses API (`/responses`)
- `OpenAiClient.layer({ apiUrl, apiKey, transformClient, ... })`
- `OpenAiLanguageModel.layer({ model, config? })`
- `OpenAiClient` consumes `HttpClient` from context
- `apiKey` is optional

## Reference Implementation Pattern

Use `.repos/lalph` as the implementation style reference:

- `.repos/lalph/src/Github/TokenManager.ts`
  - device flow orchestration
  - `Semaphore.makeUnsafe(1).withPermit(...)`
  - `KeyValueStore.prefix + toSchemaStore`
- `.repos/lalph/src/Linear/TokenManager.ts`
  - refresh/fallback pattern
  - `Effect.uninterruptibleMask` + `restore`

## Dependencies

| Package                 | Purpose                                             |
| ----------------------- | --------------------------------------------------- |
| `effect`                | Schema, Layer, HttpClient, KeyValueStore, Semaphore |
| `@effect/ai-openai`     | OpenAI Responses API provider integration           |
| `@effect/platform-node` | Node HttpClient / FileSystem / Path layers          |

## Public API

### `src/CodexAuth.ts`

| Export           | Type                                                   | Description                                    |
| ---------------- | ------------------------------------------------------ | ---------------------------------------------- |
| `CodexAuth`      | `ServiceMap.Service`                                   | Auth service (`get`, `authenticate`, `logout`) |
| `CodexAuthError` | `Schema.TaggedErrorClass`                              | Auth-specific error                            |
| `TokenData`      | `Schema.Class`                                         | Persisted token model                          |
| `layer`          | `Layer<CodexAuth, never, KeyValueStore \| HttpClient>` | Auth service layer                             |
| `layerClient`    | `Layer<HttpClient, never, CodexAuth \| HttpClient>`    | Auth-injecting HttpClient layer                |

### `src/Codex.ts`

| Export  | Type                                                                                            | Description                |
| ------- | ----------------------------------------------------------------------------------------------- | -------------------------- |
| `layer` | `Layer<LanguageModel \| OpenAiClient, never, KeyValueStore \| HttpClient>`                      | Default Codex model wiring |
| `model` | `(modelId: string) => Layer<LanguageModel \| OpenAiClient, never, KeyValueStore \| HttpClient>` | Parameterized model wiring |

## Architecture

```text
Consumer program
  -> LanguageModel (OpenAiLanguageModel.layer)
  -> OpenAiClient.layer({ apiUrl: "https://chatgpt.com/backend-api/codex" })
  -> HttpClient (provided by CodexAuth.layerClient)
  -> Network (Codex /responses endpoint)

CodexAuth.layer (separate service)
  -> KeyValueStore + raw HttpClient
  -> device flow, refresh, persistence, concurrency guard
```

## Design Decisions

### 1) Codex endpoint via `apiUrl` (no URL rewriting)

Set:

```ts
OpenAiClient.layer({ apiUrl: "https://chatgpt.com/backend-api/codex" })
```

`OpenAiClient` appends `/responses`, yielding the correct Codex endpoint.

### 2) No dummy API key

`apiKey` remains unset. Authorization header comes from auth-aware `HttpClient`.

### 3) Separate auth service and auth-aware HttpClient layer

`CodexAuth.layer` builds auth state from raw `HttpClient` and `KeyValueStore`.
`CodexAuth.layerClient` wraps a base `HttpClient` and injects headers per
request using `HttpClient.mapRequestEffect`.

This avoids trying to do effectful token retrieval inside
`OpenAiClient.transformClient` directly.

### 4) Concurrency with semaphore

Use `Semaphore.makeUnsafe(1).withPermit(...)` so only one concurrent caller can
perform refresh/device auth while others wait and reuse resulting token.

## Module Specification: `CodexAuth`

### Constants

```ts
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const CODEX_API_BASE = "https://chatgpt.com/backend-api/codex"
const POLLING_SAFETY_MARGIN_MS = 3000
const TOKEN_EXPIRY_BUFFER_MS = 30_000
const STORE_PREFIX = "codex.auth/"
const STORE_TOKEN_KEY = "token"
```

### Token model

```ts
class TokenData extends Schema.Class<TokenData>("clanka/CodexAuth/TokenData")({
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Number,
  accountId: Schema.optionalWith(Schema.String, { as: "Option" }),
}) {
  isExpired(): boolean {
    return this.expires < Date.now() + TOKEN_EXPIRY_BUFFER_MS
  }
}
```

Persist with:

```ts
const kvs = KeyValueStore.prefix(baseKvs, STORE_PREFIX)
const store = KeyValueStore.toSchemaStore(kvs, TokenData)
```

### Error model

```ts
class CodexAuthError extends Schema.TaggedErrorClass<CodexAuthError>()(
  "CodexAuthError",
  {
    reason: Schema.Literal(
      "DeviceFlowFailed",
      "TokenExchangeFailed",
      "RefreshFailed",
    ),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}
```

JWT claim parsing is best-effort metadata extraction for the optional
`ChatGPT-Account-Id` header. Malformed JWTs should stay on the
`Option.none()` path and must not surface a separate auth error.

### Service shape

```ts
class CodexAuth extends ServiceMap.Service<CodexAuth>()("clanka/CodexAuth", {
  make: Effect.gen(function* () {
    // returns { get, authenticate, logout }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
```

Service methods:

- `get`: returns a valid token (cached / refreshed / newly authenticated)
- `authenticate`: force device flow now and replace stored token
- `logout`: clear token from memory and storage

### Device flow behavior

1. Request user code:
   - `POST /api/accounts/deviceauth/usercode`
   - JSON body `{ client_id }`
2. Print instructions:
   - URL: `https://auth.openai.com/codex/device`
   - code: `user_code`
3. Poll authorization:
   - `POST /api/accounts/deviceauth/token`
   - JSON body `{ device_auth_id, user_code }`
   - interval: `Math.max(parseInt(interval) || 5, 1) * 1000`
4. Exchange code:
   - `POST /oauth/token`
   - `application/x-www-form-urlencoded`
   - grant_type `authorization_code`
   - redirect_uri `https://auth.openai.com/deviceauth/callback`
5. Parse account ID from JWT claims
6. Persist `TokenData`

### Polling semantics (critical)

Do **not** rely on `filterStatusOk + retryTransient` for pending states.

Pending states are part of normal control flow (`403` / `404`) and should be
handled explicitly by inspecting status codes.

Recommended polling branch logic:

- `200`: decode success payload (`authorization_code`, `code_verifier`)
- `403` or `404`: treat as pending, delay, continue polling
- any other status: fail with `DeviceFlowFailed`

Transport-level failures may still use retry/backoff, but pending is not retry
error semantics.

### Refresh behavior

When `get` is called and token is expired:

1. Attempt refresh (`grant_type=refresh_token`)
2. If refresh succeeds: persist and return refreshed token
3. If refresh fails: downgrade to fallback (`Option.none`) and run full device
   flow once
4. If device flow fails: surface `DeviceFlowFailed`

`RefreshFailed` is still captured for diagnostics, but terminal failure after
fallback is the device flow failure.

### Concurrency behavior

Protect both `get` and `authenticate` with the same semaphore permit.

This prevents parallel refresh/device-flow races and ensures consistent token
cache/store updates.

### HttpClient auth layer

`layerClient` wraps an existing client and injects:

- `Authorization: Bearer <access>`
- `ChatGPT-Account-Id: <accountId>` when present

If `get` fails, convert to defect at this boundary (to satisfy `HttpClient`
service shape) and include contextual message.

## Module Specification: `Codex`

### Layer composition

Use explicit `CodexAuth.layer` (not `Default`).

High-level composition steps:

1. Build auth service:
   - `CodexAuth.layer` from `KeyValueStore` + **raw** `HttpClient`
2. Build auth-aware client:
   - `CodexAuth.layerClient` from `CodexAuth` + **raw** `HttpClient`
3. Build OpenAI services on top of auth-aware client:
   - `OpenAiClient.layer({ apiUrl: CODEX_API_BASE })`
   - `OpenAiLanguageModel.layer({ model: ... })`

### Important layering constraint

Avoid cyclic/self-fed `HttpClient` composition:

- `CodexAuth.layer` must read from raw/base `HttpClient`
- `layerClient` provides a wrapped `HttpClient` for consumers (`OpenAiClient`)
- Do not feed wrapped `HttpClient` back into `CodexAuth.layer`

## Testing Strategy

### Unit (`src/CodexAuth.test.ts`)

- Token schema store round-trip (`KeyValueStore.layerMemory`)
- JWT parsing:
  - each claim location
  - malformed token / malformed payload
- Polling behavior:
  - `403` pending then `200` success path
  - non-403/404 non-200 failure path
- Refresh behavior:
  - successful refresh
  - failed refresh -> device flow fallback
- Concurrency:
  - parallel `get` calls trigger one refresh/device flow
- Logout clears memory + storage

Use `TestClock` for deterministic delay/polling tests.

### Integration (`src/Codex.test.ts`)

- Header injection from `layerClient`
- Layer availability checks for `OpenAiClient` and `LanguageModel`
- No external network calls; use mock `HttpClient` layer

## Implementation Notes

- `verbatimModuleSyntax: true`: use `import type` where applicable
- `erasableSyntaxOnly: true`: avoid non-erasable TS constructs
- `no-explicit-any`: use `Schema.decodeUnknown` or `unknown` narrowing
- Keep helpers factored for independent task-level validation
- After each task: `pnpm check && pnpm vitest run`

## Implementation Plan

### Task 1: Core Types and Storage Seams

**Files**: `src/CodexAuth.ts`, `src/CodexAuth.test.ts`

Implement constants, `TokenData`, `CodexAuthError`, and exported/internal
storage helpers (`prefix + schema store`).

**Acceptance criteria**

- `TokenData` and `CodexAuthError` compile and are exported
- Round-trip persistence tests pass with `KeyValueStore.layerMemory`
- `pnpm check && pnpm vitest run` passes

### Task 2: Pure JWT Parsing Helpers

**Files**: `src/CodexAuth.ts`, `src/CodexAuth.test.ts`

Implement pure JWT parsing/account extraction helpers using
`Encoding.decodeBase64Url` + schema decode.

**Acceptance criteria**

- All account-id claim shapes supported
- Malformed tokens safely return `Option.none()` without entering the auth error channel
- No `any` usage
- `pnpm check && pnpm vitest run` passes

### Task 3: OAuth HTTP Primitives

**Files**: `src/CodexAuth.ts`, `src/CodexAuth.test.ts`

Implement composable effects:

- `requestDeviceCode`
- `pollAuthorization`
- `exchangeAuthorizationCode`
- `refreshToken`

with explicit status handling for poll (`200` / `403` / `404` / other).

**Acceptance criteria**

- Polling pending semantics are explicit and correct
- Poll delays use interval + safety margin
- Token exchange/refresh payloads are correctly encoded
- Deterministic tests pass (including clock-based polling)
- `pnpm check && pnpm vitest run` passes

### Task 4: `CodexAuth` Service Orchestration

**Files**: `src/CodexAuth.ts`, `src/CodexAuth.test.ts`

Wire cache + persistence + semaphore + fallback policy into
`ServiceMap.Service`.

**Acceptance criteria**

- `get`, `authenticate`, `logout` implemented
- refresh failure falls back to device flow
- semaphore serialization verified with concurrent test
- terminal error mapping is consistent and documented
- `pnpm check && pnpm vitest run` passes

### Task 5: Layer Wiring (`layerClient` and `Codex`)

**Files**: `src/CodexAuth.ts`, `src/Codex.ts`, `src/Codex.test.ts`

Add `layerClient` and compose final `Codex.layer` / `Codex.model(modelId)`.

**Acceptance criteria**

- `OpenAiClient` uses `apiUrl: CODEX_API_BASE`
- auth headers injected correctly per request
- no `CodexAuth.Default` references
- no cyclic `HttpClient` composition
- layer availability tests pass without external network
- `pnpm check && pnpm vitest run` passes

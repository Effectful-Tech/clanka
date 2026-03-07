import { Schema } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const ISSUER = "https://auth.openai.com"
export const CODEX_API_BASE = "https://chatgpt.com/backend-api/codex"
export const POLLING_SAFETY_MARGIN_MS = 3000
export const TOKEN_EXPIRY_BUFFER_MS = 30_000
export const STORE_PREFIX = "codex.auth/"
export const STORE_TOKEN_KEY = "token"

export class TokenData extends Schema.Class<TokenData>(
  "clanka/CodexAuth/TokenData",
)({
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Number,
  accountId: Schema.OptionFromOptional(Schema.String),
}) {
  isExpired(): boolean {
    return this.expires < Date.now() + TOKEN_EXPIRY_BUFFER_MS
  }
}

export class CodexAuthError extends Schema.TaggedErrorClass<CodexAuthError>()(
  "CodexAuthError",
  {
    reason: Schema.Literals([
      "DeviceFlowFailed",
      "TokenExchangeFailed",
      "RefreshFailed",
      "JwtParseFailed",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const toCodexAuthKeyValueStore = (store: KeyValueStore.KeyValueStore) =>
  KeyValueStore.prefix(store, STORE_PREFIX)

export const toTokenStore = (store: KeyValueStore.KeyValueStore) =>
  KeyValueStore.toSchemaStore(toCodexAuthKeyValueStore(store), TokenData)

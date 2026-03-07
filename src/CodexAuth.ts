import { Encoding, Option, Result, Schema } from "effect"
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

const JwtAccountClaimSchema = Schema.Struct({
  chatgpt_account_id: Schema.optional(Schema.String),
})

const JwtOrganizationSchema = Schema.Struct({
  id: Schema.String,
})

const JwtClaimsSchema = Schema.Struct({
  chatgpt_account_id: Schema.optional(Schema.String),
  "https://api.openai.com/auth": Schema.optional(JwtAccountClaimSchema),
  organizations: Schema.optional(Schema.Array(JwtOrganizationSchema)),
})

export type JwtClaims = typeof JwtClaimsSchema.Type

const decodeJwtClaims = Schema.decodeUnknownOption(
  Schema.fromJsonString(JwtClaimsSchema),
)

const decodeJwtPayload = (token: string): Option.Option<string> => {
  const parts = token.split(".")
  if (parts.length !== 3) {
    return Option.none()
  }

  const payload = parts[1]
  if (payload === undefined) {
    return Option.none()
  }

  return Option.fromNullishOr(
    Result.getOrUndefined(Encoding.decodeBase64UrlString(payload)),
  )
}

export const parseJwtClaims = (token: string): Option.Option<JwtClaims> =>
  decodeJwtPayload(token).pipe(Option.flatMap(decodeJwtClaims))

export const extractAccountIdFromClaims = (
  claims: JwtClaims,
): Option.Option<string> => {
  if (claims.chatgpt_account_id !== undefined) {
    return Option.some(claims.chatgpt_account_id)
  }

  const nestedAccountId =
    claims["https://api.openai.com/auth"]?.chatgpt_account_id
  if (nestedAccountId !== undefined) {
    return Option.some(nestedAccountId)
  }

  return Option.fromNullishOr(claims.organizations?.[0]?.id)
}

export const extractAccountIdFromToken = (
  token: string,
): Option.Option<string> =>
  parseJwtClaims(token).pipe(Option.flatMap(extractAccountIdFromClaims))

export const toCodexAuthKeyValueStore = (store: KeyValueStore.KeyValueStore) =>
  KeyValueStore.prefix(store, STORE_PREFIX)

export const toTokenStore = (store: KeyValueStore.KeyValueStore) =>
  KeyValueStore.toSchemaStore(toCodexAuthKeyValueStore(store), TokenData)

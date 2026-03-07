import {
  Console,
  Effect,
  Encoding,
  Layer,
  Option,
  Result,
  Schema,
  Semaphore,
  ServiceMap,
} from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { KeyValueStore } from "effect/unstable/persistence"

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const ISSUER = "https://auth.openai.com"
export const CODEX_API_BASE = "https://chatgpt.com/backend-api/codex"
export const POLLING_SAFETY_MARGIN_MS = 3000
export const TOKEN_EXPIRY_BUFFER_MS = 30_000
export const STORE_PREFIX = "codex.auth/"
export const STORE_TOKEN_KEY = "token"

const DEVICE_CODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`
const DEVICE_TOKEN_URL = `${ISSUER}/api/accounts/deviceauth/token`
const TOKEN_URL = `${ISSUER}/oauth/token`
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`
const DEVICE_VERIFICATION_URL = `${ISSUER}/codex/device`
const DEFAULT_DEVICE_POLL_INTERVAL_SECONDS = 5
const DEFAULT_TOKEN_EXPIRY_SECONDS = 3600

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

const DeviceCodeResponseSchema = Schema.Struct({
  device_auth_id: Schema.String,
  user_code: Schema.String,
  interval: Schema.String,
})

const AuthorizationCodeResponseSchema = Schema.Struct({
  authorization_code: Schema.String,
  code_verifier: Schema.String,
})

const TokenResponseSchema = Schema.Struct({
  id_token: Schema.optional(Schema.String),
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.optional(Schema.Number),
})

type TokenResponse = typeof TokenResponseSchema.Type

export interface DeviceCodeData {
  readonly deviceAuthId: string
  readonly userCode: string
  readonly intervalMs: number
}

export interface AuthorizationCodeData {
  readonly authorizationCode: string
  readonly codeVerifier: string
}

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
  if (
    claims.chatgpt_account_id !== undefined &&
    claims.chatgpt_account_id !== ""
  ) {
    return Option.some(claims.chatgpt_account_id)
  }

  const nestedAccountId =
    claims["https://api.openai.com/auth"]?.chatgpt_account_id
  if (nestedAccountId !== undefined && nestedAccountId !== "") {
    return Option.some(nestedAccountId)
  }

  return Option.fromNullishOr(claims.organizations?.[0]?.id)
}

export const extractAccountIdFromToken = (
  token: string,
): Option.Option<string> =>
  parseJwtClaims(token).pipe(Option.flatMap(extractAccountIdFromClaims))

const isSuccessfulStatus = (status: number): boolean =>
  status >= 200 && status < 300

const normalizePollInterval = (interval: string): number =>
  Math.max(
    Number.parseInt(interval, 10) || DEFAULT_DEVICE_POLL_INTERVAL_SECONDS,
    1,
  ) * 1_000

const extractAccountIdFromTokens = (
  token: TokenResponse,
): Option.Option<string> => {
  if (token.id_token !== undefined && token.id_token !== "") {
    const accountId = extractAccountIdFromToken(token.id_token)
    if (Option.isSome(accountId)) {
      return accountId
    }
  }

  return extractAccountIdFromToken(token.access_token)
}

const toTokenDataFromResponse = (token: TokenResponse): TokenData =>
  new TokenData({
    access: token.access_token,
    refresh: token.refresh_token,
    expires:
      Date.now() + (token.expires_in ?? DEFAULT_TOKEN_EXPIRY_SECONDS) * 1_000,
    accountId: extractAccountIdFromTokens(token),
  })

const requestDeviceCodeError = (message: string, cause?: unknown) =>
  new CodexAuthError({
    reason: "DeviceFlowFailed",
    message,
    ...(cause === undefined ? {} : { cause }),
  })

const tokenExchangeError = (message: string, cause?: unknown) =>
  new CodexAuthError({
    reason: "TokenExchangeFailed",
    message,
    ...(cause === undefined ? {} : { cause }),
  })

const refreshTokenError = (message: string, cause?: unknown) =>
  new CodexAuthError({
    reason: "RefreshFailed",
    message,
    ...(cause === undefined ? {} : { cause }),
  })

export const requestDeviceCode = Effect.fn("CodexAuth.requestDeviceCode")(
  function* (): Effect.fn.Return<
    DeviceCodeData,
    CodexAuthError,
    HttpClient.HttpClient
  > {
    const response = yield* HttpClientRequest.post(DEVICE_CODE_URL).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        client_id: CLIENT_ID,
      }),
      HttpClient.execute,
      Effect.mapError((cause) =>
        requestDeviceCodeError(
          "Failed to request a Codex device authorization code",
          cause,
        ),
      ),
    )

    if (!isSuccessfulStatus(response.status)) {
      return yield* requestDeviceCodeError(
        `Failed to request a Codex device authorization code: ${response.status}`,
      )
    }

    const payload = yield* HttpClientResponse.schemaBodyJson(
      DeviceCodeResponseSchema,
    )(response).pipe(
      Effect.mapError((cause) =>
        requestDeviceCodeError(
          "Failed to decode the Codex device authorization response",
          cause,
        ),
      ),
    )

    return {
      deviceAuthId: payload.device_auth_id,
      userCode: payload.user_code,
      intervalMs: normalizePollInterval(payload.interval),
    }
  },
)

export const pollAuthorization = Effect.fn("CodexAuth.pollAuthorization")(
  function* (
    deviceCode: DeviceCodeData,
  ): Effect.fn.Return<
    AuthorizationCodeData,
    CodexAuthError,
    HttpClient.HttpClient
  > {
    const request = HttpClientRequest.post(DEVICE_TOKEN_URL).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        device_auth_id: deviceCode.deviceAuthId,
        user_code: deviceCode.userCode,
      }),
    )

    const delayMs = deviceCode.intervalMs + POLLING_SAFETY_MARGIN_MS

    const loop: Effect.Effect<
      AuthorizationCodeData,
      CodexAuthError,
      HttpClient.HttpClient
    > = Effect.suspend(() =>
      HttpClient.execute(request).pipe(
        Effect.mapError((cause) =>
          requestDeviceCodeError(
            "Failed to poll Codex device authorization",
            cause,
          ),
        ),
        Effect.flatMap((response) => {
          if (response.status === 200) {
            return HttpClientResponse.schemaBodyJson(
              AuthorizationCodeResponseSchema,
            )(response).pipe(
              Effect.mapError((cause) =>
                requestDeviceCodeError(
                  "Failed to decode the Codex authorization approval response",
                  cause,
                ),
              ),
              Effect.map((payload) => ({
                authorizationCode: payload.authorization_code,
                codeVerifier: payload.code_verifier,
              })),
            )
          }

          if (response.status === 403 || response.status === 404) {
            return Effect.sleep(delayMs).pipe(Effect.andThen(loop))
          }

          return Effect.fail(
            requestDeviceCodeError(
              `Codex device authorization failed while polling: ${response.status}`,
            ),
          )
        }),
      ),
    )

    return yield* loop
  },
)

export const exchangeAuthorizationCode = Effect.fn(
  "CodexAuth.exchangeAuthorizationCode",
)(function* (
  authorization: AuthorizationCodeData,
): Effect.fn.Return<TokenData, CodexAuthError, HttpClient.HttpClient> {
  const response = yield* HttpClientRequest.post(TOKEN_URL).pipe(
    HttpClientRequest.bodyUrlParams({
      grant_type: "authorization_code",
      code: authorization.authorizationCode,
      redirect_uri: DEVICE_REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: authorization.codeVerifier,
    }),
    HttpClient.execute,
    Effect.mapError((cause) =>
      tokenExchangeError(
        "Failed to exchange the Codex authorization code",
        cause,
      ),
    ),
  )

  if (!isSuccessfulStatus(response.status)) {
    return yield* tokenExchangeError(
      `Codex token exchange failed: ${response.status}`,
    )
  }

  const payload = yield* HttpClientResponse.schemaBodyJson(TokenResponseSchema)(
    response,
  ).pipe(
    Effect.mapError((cause) =>
      tokenExchangeError(
        "Failed to decode the Codex token exchange response",
        cause,
      ),
    ),
  )

  return toTokenDataFromResponse(payload)
})

export const refreshToken = Effect.fn("CodexAuth.refreshToken")(function* (
  refresh: string,
): Effect.fn.Return<TokenData, CodexAuthError, HttpClient.HttpClient> {
  const response = yield* HttpClientRequest.post(TOKEN_URL).pipe(
    HttpClientRequest.bodyUrlParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: CLIENT_ID,
    }),
    HttpClient.execute,
    Effect.mapError((cause) =>
      refreshTokenError("Failed to refresh the Codex access token", cause),
    ),
  )

  if (!isSuccessfulStatus(response.status)) {
    return yield* refreshTokenError(
      `Codex token refresh failed: ${response.status}`,
    )
  }

  const payload = yield* HttpClientResponse.schemaBodyJson(TokenResponseSchema)(
    response,
  ).pipe(
    Effect.mapError((cause) =>
      refreshTokenError(
        "Failed to decode the Codex refresh token response",
        cause,
      ),
    ),
  )

  return toTokenDataFromResponse(payload)
})

export const toCodexAuthKeyValueStore = (store: KeyValueStore.KeyValueStore) =>
  KeyValueStore.prefix(store, STORE_PREFIX)

export const toTokenStore = (store: KeyValueStore.KeyValueStore) =>
  KeyValueStore.toSchemaStore(toCodexAuthKeyValueStore(store), TokenData)

export class CodexAuth extends ServiceMap.Service<CodexAuth>()(
  "clanka/CodexAuth",
  {
    make: Effect.gen(function* () {
      const tokenStore = toTokenStore(yield* KeyValueStore.KeyValueStore)
      const httpClient = yield* HttpClient.HttpClient
      const semaphore = Semaphore.makeUnsafe(1)

      let currentToken = yield* tokenStore.get(STORE_TOKEN_KEY).pipe(
        Effect.catchTag("SchemaError", (error) =>
          Console.warn(
            `Failed to decode persisted Codex token, clearing it: ${error.message}`,
          ).pipe(
            Effect.andThen(tokenStore.remove(STORE_TOKEN_KEY)),
            Effect.as(Option.none()),
          ),
        ),
        Effect.orDie,
      )

      const withHttpClient = <A, E>(
        effect: Effect.Effect<A, E, HttpClient.HttpClient>,
      ): Effect.Effect<A, E> =>
        Effect.provideService(effect, HttpClient.HttpClient, httpClient)

      const saveToken = (token: TokenData) =>
        Effect.orDie(tokenStore.set(STORE_TOKEN_KEY, token)).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              currentToken = Option.some(token)
            }),
          ),
          Effect.as(token),
        )

      const clearToken = Effect.orDie(tokenStore.remove(STORE_TOKEN_KEY)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            currentToken = Option.none()
          }),
        ),
      )

      const authenticateWithDeviceFlow = Effect.gen(function* () {
        const deviceCode = yield* withHttpClient(requestDeviceCode())
        yield* Console.log(
          `Open ${DEVICE_VERIFICATION_URL} and enter code: ${deviceCode.userCode}`,
        )
        const authorization = yield* withHttpClient(
          pollAuthorization(deviceCode),
        )
        return yield* withHttpClient(exchangeAuthorizationCode(authorization))
      })

      const authenticateNoLock = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const token = yield* restore(authenticateWithDeviceFlow)
          return yield* saveToken(token)
        }),
      )

      const getNoLock = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (Option.isSome(currentToken) && !currentToken.value.isExpired()) {
            return currentToken.value
          }

          if (Option.isNone(currentToken)) {
            const token = yield* restore(authenticateWithDeviceFlow)
            return yield* saveToken(token)
          }

          const refreshedToken = yield* restore(
            withHttpClient(refreshToken(currentToken.value.refresh)).pipe(
              Effect.tapError((error) =>
                Console.warn(
                  `Codex token refresh failed, falling back to device auth: ${error.message}`,
                ),
              ),
              Effect.option,
            ),
          )

          if (Option.isSome(refreshedToken)) {
            return yield* saveToken(refreshedToken.value)
          }

          yield* clearToken
          const token = yield* restore(authenticateWithDeviceFlow)
          return yield* saveToken(token)
        }),
      )

      return {
        get: semaphore.withPermit(getNoLock),
        authenticate: semaphore.withPermit(authenticateNoLock),
        logout: semaphore.withPermit(Effect.uninterruptible(clearToken)),
      } as const
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
}

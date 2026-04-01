/**
 * @since 1.0.0
 */
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Function from "effect/Function"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as ServiceMap from "effect/ServiceMap"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const ISSUER = "https://auth.openai.com"
export const POLLING_SAFETY_MARGIN_MS = 3000
export const TOKEN_EXPIRY_BUFFER_MS = 30_000
export const STORE_PREFIX = "codex.auth/"
export const STORE_TOKEN_KEY = "token"

const DEVICE_CODE_URL = `/api/accounts/deviceauth/usercode`
const DEVICE_TOKEN_URL = `/api/accounts/deviceauth/token`
const TOKEN_URL = `/oauth/token`
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`
const DEVICE_VERIFICATION_URL = `/codex/device`
const DEFAULT_DEVICE_POLL_INTERVAL_SECONDS = 5
const DEFAULT_TOKEN_EXPIRY_SECONDS = 3600
const ACCOUNT_ID_HEADER = "ChatGPT-Account-Id"

export class CodexVerification extends ServiceMap.Service<
  CodexVerification,
  {
    onCode(options: {
      readonly verifyUrl: string
      readonly code: string
    }): Effect.Effect<void, CodexAuthError>
  }
>()("clanka/CodexAuth/CodexVerification") {
  static readonly layerConsole = Layer.succeed(this, {
    onCode: (options) =>
      Console.log(`Open ${options.verifyUrl} and enter code ${options.code}`),
  })
}

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

export interface JwtClaims {
  readonly chatgpt_account_id?: string
  readonly "https://api.openai.com/auth"?: {
    readonly chatgpt_account_id?: string
  }
  readonly organizations?: ReadonlyArray<{
    readonly id: string
  }>
}

const decodeJwtJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown),
)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const getString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

const toJwtClaims = (value: unknown): Option.Option<JwtClaims> => {
  if (!isRecord(value)) {
    return Option.none()
  }

  const accountId = getString(value["chatgpt_account_id"])
  const authValue = value["https://api.openai.com/auth"]
  const nestedAccountId = isRecord(authValue)
    ? getString(authValue["chatgpt_account_id"])
    : undefined
  const organizationsValue = value["organizations"]
  const organizationId =
    Array.isArray(organizationsValue) &&
    organizationsValue[0] !== undefined &&
    isRecord(organizationsValue[0])
      ? getString(organizationsValue[0]["id"])
      : undefined

  return Option.some({
    ...(accountId === undefined ? {} : { chatgpt_account_id: accountId }),
    ...(nestedAccountId === undefined
      ? {}
      : {
          "https://api.openai.com/auth": {
            chatgpt_account_id: nestedAccountId,
          },
        }),
    ...(organizationId === undefined
      ? {}
      : {
          organizations: [{ id: organizationId }],
        }),
  })
}

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
  decodeJwtPayload(token).pipe(
    Option.flatMap(decodeJwtJson),
    Option.flatMap(toJwtClaims),
  )

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

  const organizationId = claims.organizations?.[0]?.id
  if (organizationId !== undefined && organizationId !== "") {
    return Option.some(organizationId)
  }

  return Option.none()
}

export const extractAccountIdFromToken = (
  token: string,
): Option.Option<string> =>
  parseJwtClaims(token).pipe(Option.flatMap(extractAccountIdFromClaims))

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

const applyTokenHeaders = (
  request: HttpClientRequest.HttpClientRequest,
  token: TokenData,
): HttpClientRequest.HttpClientRequest => {
  const authenticatedRequest = request.pipe(
    HttpClientRequest.bearerToken(token.access),
  )

  return Option.match(token.accountId, {
    onNone: () => authenticatedRequest,
    onSome: (accountId) =>
      authenticatedRequest.pipe(
        HttpClientRequest.setHeader(ACCOUNT_ID_HEADER, accountId),
      ),
  })
}

const toTokenDataFromResponse = (token: TokenResponse): TokenData =>
  new TokenData({
    access: token.access_token,
    refresh: token.refresh_token,
    expires:
      Date.now() + (token.expires_in ?? DEFAULT_TOKEN_EXPIRY_SECONDS) * 1_000,
    accountId: extractAccountIdFromTokens(token),
  })

const preserveAccountId = (
  token: TokenData,
  fallback: Option.Option<string>,
): TokenData => {
  if (Option.isSome(token.accountId) || Option.isNone(fallback)) {
    return token
  }

  return new TokenData({
    access: token.access,
    refresh: token.refresh,
    expires: token.expires,
    accountId: fallback,
  })
}

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

export const toCodexAuthKeyValueStore = (store: KeyValueStore.KeyValueStore) =>
  KeyValueStore.prefix(store, STORE_PREFIX)

export const toTokenStore = (store: KeyValueStore.KeyValueStore) =>
  KeyValueStore.toSchemaStore(toCodexAuthKeyValueStore(store), TokenData)

export class CodexAuth extends ServiceMap.Service<
  CodexAuth,
  {
    readonly verifyUrl: string
    readonly get: Effect.Effect<TokenData, CodexAuthError>
    readonly authenticate: Effect.Effect<TokenData, CodexAuthError>
    readonly logout: Effect.Effect<void>
  }
>()("clanka/CodexAuth") {
  static readonly make = Effect.gen(function* () {
    const verfication = yield* CodexVerification
    const tokenStore = toTokenStore(yield* KeyValueStore.KeyValueStore)
    const httpClient = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(
        Function.flow(HttpClientRequest.prependUrl(ISSUER)),
      ),
      HttpClient.filterStatusOk,
      HttpClient.retryTransient({
        times: 5,
        schedule: Schedule.exponential(150).pipe(
          Schedule.either(Schedule.spaced(5000)),
        ),
      }),
    )
    const semaphore = Semaphore.makeUnsafe(1)

    let currentToken = yield* tokenStore.get(STORE_TOKEN_KEY).pipe(
      Effect.catchTag("SchemaError", (error) =>
        Effect.logDebug(
          `Failed to decode persisted Codex token, clearing it: ${error.message}`,
        ).pipe(
          Effect.andThen(tokenStore.remove(STORE_TOKEN_KEY)),
          Effect.as(Option.none()),
        ),
      ),
      Effect.orDie,
    )

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
      const deviceCode = yield* requestDeviceCode
      yield* verfication.onCode({
        verifyUrl: ISSUER + DEVICE_VERIFICATION_URL,
        code: deviceCode.userCode,
      })
      const authorization = yield* pollAuthorization(deviceCode)
      return yield* exchangeAuthorizationCode(authorization)
    })

    const authenticateNoLock = Effect.uninterruptibleMask(
      Effect.fnUntraced(function* (restore) {
        const token = yield* restore(authenticateWithDeviceFlow)
        return yield* saveToken(token)
      }),
    )

    const getNoLock = Effect.uninterruptibleMask(
      Effect.fnUntraced(function* (restore) {
        if (Option.isSome(currentToken) && !currentToken.value.isExpired()) {
          return currentToken.value
        }

        if (Option.isNone(currentToken)) {
          const token = yield* restore(authenticateWithDeviceFlow)
          return yield* saveToken(token)
        }

        const refreshedToken = yield* restore(
          refreshToken(currentToken.value.refresh).pipe(Effect.option),
        )

        if (Option.isSome(refreshedToken)) {
          return yield* saveToken(
            preserveAccountId(
              refreshedToken.value,
              currentToken.value.accountId,
            ),
          )
        }

        yield* clearToken
        const token = yield* restore(authenticateWithDeviceFlow)
        return yield* saveToken(token)
      }),
    )

    const requestDeviceCode = Effect.gen(function* (): Effect.fn.Return<
      DeviceCodeData,
      CodexAuthError
    > {
      const response = yield* HttpClientRequest.post(DEVICE_CODE_URL).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          client_id: CLIENT_ID,
        }),
        httpClient.execute,
        Effect.mapError((cause) =>
          requestDeviceCodeError(
            "Failed to request a Codex device authorization code",
            cause,
          ),
        ),
      )

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
    }).pipe(Effect.withSpan("CodexAuth.requestDeviceCode"))

    const pollAuthorization = Effect.fn("CodexAuth.pollAuthorization")(
      function* (
        deviceCode: DeviceCodeData,
      ): Effect.fn.Return<AuthorizationCodeData, CodexAuthError> {
        const request = HttpClientRequest.post(DEVICE_TOKEN_URL).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            device_auth_id: deviceCode.deviceAuthId,
            user_code: deviceCode.userCode,
          }),
        )

        const delayMs = deviceCode.intervalMs + POLLING_SAFETY_MARGIN_MS

        return yield* httpClient.execute(request).pipe(
          Effect.retry({
            while: (e) =>
              e.response?.status === 403 || e.response?.status === 404,
            schedule: Schedule.spaced(delayMs),
          }),
          Effect.mapError((cause) =>
            requestDeviceCodeError(
              "Failed to poll Codex device authorization",
              cause,
            ),
          ),
          Effect.flatMap((response) =>
            HttpClientResponse.schemaBodyJson(AuthorizationCodeResponseSchema)(
              response,
            ).pipe(
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
            ),
          ),
        )
      },
    )

    const exchangeAuthorizationCode = Effect.fn(
      "CodexAuth.exchangeAuthorizationCode",
    )(function* (
      authorization: AuthorizationCodeData,
    ): Effect.fn.Return<TokenData, CodexAuthError> {
      const response = yield* HttpClientRequest.post(TOKEN_URL).pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: "authorization_code",
          code: authorization.authorizationCode,
          redirect_uri: DEVICE_REDIRECT_URI,
          client_id: CLIENT_ID,
          code_verifier: authorization.codeVerifier,
        }),
        httpClient.execute,
        Effect.mapError((cause) =>
          tokenExchangeError(
            "Failed to exchange the Codex authorization code",
            cause,
          ),
        ),
      )

      const payload = yield* HttpClientResponse.schemaBodyJson(
        TokenResponseSchema,
      )(response).pipe(
        Effect.mapError((cause) =>
          tokenExchangeError(
            "Failed to decode the Codex token exchange response",
            cause,
          ),
        ),
      )

      return toTokenDataFromResponse(payload)
    })

    const refreshToken = Effect.fn("CodexAuth.refreshToken")(function* (
      refresh: string,
    ): Effect.fn.Return<TokenData, CodexAuthError> {
      const response = yield* HttpClientRequest.post(TOKEN_URL).pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: "refresh_token",
          refresh_token: refresh,
          client_id: CLIENT_ID,
        }),
        httpClient.execute,
        Effect.mapError((cause) =>
          refreshTokenError("Failed to refresh the Codex access token", cause),
        ),
      )

      const payload = yield* HttpClientResponse.schemaBodyJson(
        TokenResponseSchema,
      )(response).pipe(
        Effect.mapError((cause) =>
          refreshTokenError(
            "Failed to decode the Codex refresh token response",
            cause,
          ),
        ),
      )

      return toTokenDataFromResponse(payload)
    })

    return CodexAuth.of({
      verifyUrl: ISSUER + DEVICE_VERIFICATION_URL,
      get: semaphore.withPermit(getNoLock),
      authenticate: semaphore.withPermit(authenticateNoLock),
      logout: semaphore.withPermit(Effect.uninterruptible(clearToken)),
    })
  })

  static readonly layer = Layer.effect(CodexAuth, CodexAuth.make)

  static readonly layerConsole = this.layer.pipe(
    Layer.provide(CodexVerification.layerConsole),
  )

  static readonly layerClientNoDeps = Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const auth = yield* CodexAuth
      const httpClient = yield* HttpClient.HttpClient

      const injectAuthHeaders = (
        request: HttpClientRequest.HttpClientRequest,
      ): Effect.Effect<HttpClientRequest.HttpClientRequest> =>
        auth.get.pipe(
          Effect.map((token) => applyTokenHeaders(request, token)),
          Effect.orDie,
        )

      return httpClient.pipe(HttpClient.mapRequestEffect(injectAuthHeaders))
    }),
  )

  static readonly layerClient = this.layerClientNoDeps.pipe(
    Layer.provide(CodexAuth.layer),
  )
}

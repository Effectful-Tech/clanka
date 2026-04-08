/**
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as Function from "effect/Function"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as Context from "effect/Context"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import { DeviceCodeHandler } from "./DeviceCodeHandler.ts"

export const CLIENT_ID = "Ov23li8tweQw6odWQebz"
export const ISSUER = "https://github.com"
export const API_URL = "https://api.githubcopilot.com"
export const DEVICE_VERIFICATION_URL = `${ISSUER}/login/device`
export const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000
export const STORE_PREFIX = "github-copilot.auth/"
export const STORE_TOKEN_KEY = "token"
export const OPENAI_INTENT_HEADER = "Openai-Intent"
export const COPILOT_VISION_REQUEST_HEADER = "Copilot-Vision-Request"
export const INITIATOR_HEADER = "x-initiator"
export const DEFAULT_OPENAI_INTENT = "conversation-edits"
export const DEFAULT_USER_AGENT = "clanka"

const DEVICE_CODE_URL = "/login/device/code"
const ACCESS_TOKEN_URL = "/login/oauth/access_token"
const DEFAULT_POLL_INTERVAL_SECONDS = 5

export class TokenData extends Schema.Class<TokenData>(
  "clanka/GithubCopilotAuth/TokenData",
)({
  access: Schema.String,
  expires: Schema.Number,
}) {
  isExpired(): boolean {
    return this.expires > 0 && this.expires < Date.now()
  }
}

export class GithubCopilotAuthError extends Schema.TaggedErrorClass<GithubCopilotAuthError>()(
  "GithubCopilotAuthError",
  {
    reason: Schema.Literal("DeviceFlowFailed"),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

const DeviceCodeResponseSchema = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  interval: Schema.optional(Schema.Number),
})

const AccessTokenResponseSchema = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  interval: Schema.optional(Schema.Number),
})

export interface DeviceCodeData {
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUri: string
  readonly intervalMs: number
}

interface CopilotRequestMetadata {
  readonly isAgent: boolean
  readonly isVision: boolean
}

const normalizePollInterval = (interval?: number): number =>
  Math.max(interval ?? DEFAULT_POLL_INTERVAL_SECONDS, 1) * 1_000

const deviceFlowError = (message: string, cause?: unknown) =>
  new GithubCopilotAuthError({
    reason: "DeviceFlowFailed",
    message,
    ...(cause === undefined ? {} : { cause }),
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseRequestJsonBody = (
  request: HttpClientRequest.HttpClientRequest,
): Option.Option<unknown> => {
  if (request.body._tag !== "Uint8Array") {
    return Option.none()
  }

  try {
    return Option.some(JSON.parse(new TextDecoder().decode(request.body.body)))
  } catch {
    return Option.none()
  }
}

const getRequestMetadataFromMessages = (
  messages: ReadonlyArray<unknown>,
): CopilotRequestMetadata => {
  const last = messages[messages.length - 1]
  const isAgent = !isRecord(last) || last["role"] !== "user"
  const isVision = messages.some((message) => {
    if (!isRecord(message) || !Array.isArray(message["content"])) {
      return false
    }

    return message["content"].some(
      (part) => isRecord(part) && part["type"] === "image_url",
    )
  })

  return { isAgent, isVision }
}

const getRequestMetadataFromInput = (
  input: ReadonlyArray<unknown>,
): CopilotRequestMetadata => {
  const last = input[input.length - 1]
  const isAgent = !isRecord(last) || last["role"] !== "user"
  const isVision = input.some((item) => {
    if (!isRecord(item) || !Array.isArray(item["content"])) {
      return false
    }

    return item["content"].some(
      (part) => isRecord(part) && part["type"] === "input_image",
    )
  })

  return { isAgent, isVision }
}

const getCopilotRequestMetadata = (
  request: HttpClientRequest.HttpClientRequest,
): CopilotRequestMetadata =>
  Option.match(parseRequestJsonBody(request), {
    onNone: () => ({
      isAgent: false,
      isVision: false,
    }),
    onSome: (body) => {
      if (!isRecord(body)) {
        return {
          isAgent: false,
          isVision: false,
        }
      }

      const messages = body["messages"]
      if (Array.isArray(messages)) {
        return getRequestMetadataFromMessages(messages)
      }

      const input = body["input"]
      if (Array.isArray(input)) {
        return getRequestMetadataFromInput(input)
      }

      return {
        isAgent: false,
        isVision: false,
      }
    },
  })

const applyCopilotHeaders = (
  request: HttpClientRequest.HttpClientRequest,
  token: TokenData,
): HttpClientRequest.HttpClientRequest => {
  const metadata = getCopilotRequestMetadata(request)
  const authenticatedRequest = request.pipe(
    HttpClientRequest.bearerToken(token.access),
    HttpClientRequest.setHeader("User-Agent", DEFAULT_USER_AGENT),
    HttpClientRequest.setHeader(OPENAI_INTENT_HEADER, DEFAULT_OPENAI_INTENT),
    HttpClientRequest.setHeader(
      INITIATOR_HEADER,
      metadata.isAgent ? "agent" : "user",
    ),
  )

  if (!metadata.isVision) {
    return authenticatedRequest
  }

  return authenticatedRequest.pipe(
    HttpClientRequest.setHeader(COPILOT_VISION_REQUEST_HEADER, "true"),
  )
}

const toTokenData = (accessToken: string): TokenData =>
  new TokenData({
    access: accessToken,
    expires: 0,
  })

export const toGithubCopilotAuthKeyValueStore = (
  store: KeyValueStore.KeyValueStore,
) => KeyValueStore.prefix(store, STORE_PREFIX)

export const toTokenStore = (store: KeyValueStore.KeyValueStore) =>
  KeyValueStore.toSchemaStore(
    toGithubCopilotAuthKeyValueStore(store),
    TokenData,
  )

export class GithubCopilotAuth extends Context.Service<
  GithubCopilotAuth,
  {
    readonly verifyUrl: string
    readonly get: Effect.Effect<TokenData, GithubCopilotAuthError>
    readonly authenticate: Effect.Effect<TokenData, GithubCopilotAuthError>
    readonly logout: Effect.Effect<void>
  }
>()("clanka/GithubCopilotAuth") {
  static readonly make = Effect.gen(function* () {
    const verfication = yield* DeviceCodeHandler
    const tokenStore = toTokenStore(yield* KeyValueStore.KeyValueStore)
    const httpClient = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(
        Function.flow(
          HttpClientRequest.prependUrl(ISSUER),
          HttpClientRequest.acceptJson,
        ),
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
          `Failed to decode persisted GitHub Copilot token, clearing it: ${error.message}`,
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

    const requestDeviceCode = Effect.fn("GithubCopilotAuth.requestDeviceCode")(
      function* (): Effect.fn.Return<DeviceCodeData, GithubCopilotAuthError> {
        const response = yield* HttpClientRequest.post(DEVICE_CODE_URL).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            client_id: CLIENT_ID,
            scope: "read:user",
          }),
          httpClient.execute,
          Effect.mapError((cause) =>
            deviceFlowError(
              "Failed to request a GitHub Copilot device authorization code",
              cause,
            ),
          ),
        )

        const payload = yield* HttpClientResponse.schemaBodyJson(
          DeviceCodeResponseSchema,
        )(response).pipe(
          Effect.mapError((cause) =>
            deviceFlowError(
              "Failed to decode the GitHub Copilot device authorization response",
              cause,
            ),
          ),
        )

        return {
          deviceCode: payload.device_code,
          userCode: payload.user_code,
          verificationUri: payload.verification_uri,
          intervalMs: normalizePollInterval(payload.interval),
        }
      },
    )

    const pollAccessToken = Effect.fn("GithubCopilotAuth.pollAccessToken")(
      function* (
        deviceCode: DeviceCodeData,
      ): Effect.fn.Return<TokenData, GithubCopilotAuthError> {
        const request = HttpClientRequest.post(ACCESS_TOKEN_URL).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            client_id: CLIENT_ID,
            device_code: deviceCode.deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        )

        let delayMs = deviceCode.intervalMs

        while (true) {
          const response = yield* request.pipe(
            httpClient.execute,
            Effect.mapError((cause) =>
              deviceFlowError(
                "Failed to poll the GitHub Copilot device authorization token",
                cause,
              ),
            ),
          )

          const payload = yield* HttpClientResponse.schemaBodyJson(
            AccessTokenResponseSchema,
          )(response).pipe(
            Effect.mapError((cause) =>
              deviceFlowError(
                "Failed to decode the GitHub Copilot access token response",
                cause,
              ),
            ),
          )

          if (
            payload.access_token !== undefined &&
            payload.access_token !== ""
          ) {
            return toTokenData(payload.access_token)
          }

          if (payload.error === "authorization_pending") {
            yield* Effect.sleep(delayMs + OAUTH_POLLING_SAFETY_MARGIN_MS)
            continue
          }

          if (payload.error === "slow_down") {
            delayMs = normalizePollInterval(payload.interval) + 5_000
            yield* Effect.sleep(delayMs + OAUTH_POLLING_SAFETY_MARGIN_MS)
            continue
          }

          if (payload.error !== undefined && payload.error !== "") {
            return yield* deviceFlowError(
              `GitHub Copilot device authorization failed: ${payload.error}`,
            )
          }

          yield* Effect.sleep(delayMs + OAUTH_POLLING_SAFETY_MARGIN_MS)
        }
      },
    )

    const authenticateWithDeviceFlow = Effect.gen(function* () {
      const deviceCode = yield* requestDeviceCode()
      yield* verfication.onCode({
        verifyUrl: deviceCode.verificationUri,
        deviceCode: deviceCode.userCode,
      })
      return yield* pollAccessToken(deviceCode)
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

        if (Option.isSome(currentToken)) {
          yield* clearToken
        }

        const token = yield* restore(authenticateWithDeviceFlow)
        return yield* saveToken(token)
      }),
    )

    return GithubCopilotAuth.of({
      verifyUrl: ISSUER + DEVICE_VERIFICATION_URL,
      get: semaphore.withPermit(getNoLock),
      authenticate: semaphore.withPermit(authenticateNoLock),
      logout: semaphore.withPermit(Effect.uninterruptible(clearToken)),
    })
  })

  static readonly layer = Layer.effect(
    GithubCopilotAuth,
    GithubCopilotAuth.make,
  )

  static readonly layerClientNoDeps = Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const auth = yield* GithubCopilotAuth
      const httpClient = yield* HttpClient.HttpClient

      const injectAuthHeaders = (
        request: HttpClientRequest.HttpClientRequest,
      ): Effect.Effect<HttpClientRequest.HttpClientRequest> =>
        auth.get.pipe(
          Effect.map((token) => applyCopilotHeaders(request, token)),
          Effect.orDie,
        )

      return httpClient.pipe(HttpClient.mapRequestEffect(injectAuthHeaders))
    }),
  )

  static readonly layerClient = this.layerClientNoDeps.pipe(
    Layer.provide(GithubCopilotAuth.layer),
  )
}

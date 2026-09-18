/**
 * @since 1.0.0
 */
/** @effect-diagnostics schemaNumber:off */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import { DeviceCodeHandler } from "./DeviceCodeHandler.ts"

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const ISSUER = "https://auth.x.ai"
const TOKEN_URL = ISSUER + "/oauth2/token"
const DEFAULT_TOKEN_EXPIRY_SECONDS = 3600
const DEFAULT_DEVICE_EXPIRY_SECONDS = 600

export class TokenData extends Schema.Class<TokenData>(
  "clanka/XaiAuth/TokenData",
)({
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Number,
}) {
  isExpired(): boolean {
    return this.expires < Date.now() + 30_000
  }
}

export class XaiAuthError extends Schema.TaggedError<XaiAuthError>()(
  "XaiAuthError",
  {
    reason: Schema.Literals(["DeviceFlowFailed", "RefreshFailed"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const DeviceCodeResponse = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.optional(Schema.Number),
})
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
})
const TokenError = Schema.Struct({
  error: Schema.String,
  interval: Schema.optional(Schema.Number),
})
const PollResponse = Schema.Union([TokenResponse, TokenError])
const toTokenData = (token: typeof TokenResponse.Type, refresh = "") =>
  new TokenData({
    access: token.access_token,
    refresh: token.refresh_token || refresh,
    expires:
      Date.now() + (token.expires_in ?? DEFAULT_TOKEN_EXPIRY_SECONDS) * 1000,
  })

export const toTokenStore = (store: KeyValueStore.KeyValueStore) =>
  KeyValueStore.toSchemaStore(
    KeyValueStore.prefix(store, "xai.auth/"),
    TokenData,
  )

export class XaiAuth extends Context.Service<
  XaiAuth,
  {
    readonly get: Effect.Effect<TokenData, XaiAuthError>
    readonly authenticate: Effect.Effect<TokenData, XaiAuthError>
    readonly logout: Effect.Effect<void>
  }
>()("clanka/XaiAuth") {
  static readonly make = Effect.gen(function* () {
    const verification = yield* DeviceCodeHandler
    const tokenStore = toTokenStore(yield* KeyValueStore.KeyValueStore)
    const httpClient = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(
        HttpClientRequest.setHeader("User-Agent", "clanka"),
      ),
      HttpClient.retryTransient({
        retryOn: "errors-and-responses",
        times: 5,
        schedule: Schedule.min([
          Schedule.exponential(150),
          Schedule.spaced(5000),
        ]),
      }),
    )
    const semaphore = Semaphore.makeUnsafe(1)
    let currentToken = yield* tokenStore.get("token").pipe(
      Effect.catchTag("SchemaError", () =>
        tokenStore.remove("token").pipe(Effect.as(Option.none())),
      ),
      Effect.orDie,
    )
    const saveToken = (token: TokenData) =>
      tokenStore.set("token", token).pipe(
        Effect.orDie,
        Effect.tap(() =>
          Effect.sync(() => {
            currentToken = Option.some(token)
          }),
        ),
        Effect.as(token),
      )
    const clearToken = tokenStore.remove("token").pipe(
      Effect.orDie,
      Effect.tap(() =>
        Effect.sync(() => {
          currentToken = Option.none()
        }),
      ),
    )

    const authenticateWithDeviceFlow = Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(
        ISSUER + "/oauth2/device/code",
      ).pipe(
        HttpClientRequest.bodyUrlParams({
          client_id: CLIENT_ID,
          scope:
            "openid profile email offline_access grok-cli:access api:access",
          referrer: "clanka",
        }),
        httpClient.execute,
        Effect.flatMap(HttpClientResponse.filterStatusOk),
      )
      const device =
        yield* HttpClientResponse.schemaBodyJson(DeviceCodeResponse)(response)
      yield* verification.onCode({
        verifyUrl: device.verification_uri,
        deviceCode: device.user_code,
      })
      const request = HttpClientRequest.post(TOKEN_URL).pipe(
        HttpClientRequest.bodyUrlParams({
          client_id: CLIENT_ID,
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      )
      let delayMs = Math.max(device.interval ?? 5, 1) * 1000
      const poll = Effect.gen(function* () {
        while (true) {
          // OAuth errors arrive as HTTP 400; decode their bodies before deciding whether to retry.
          const response = yield* httpClient.execute(request)
          const payload =
            yield* HttpClientResponse.schemaBodyJson(PollResponse)(response)
          if ("access_token" in payload) {
            yield* HttpClientResponse.filterStatusOk(response)
            return toTokenData(payload)
          }
          if (payload.error === "slow_down") {
            delayMs = Math.max(delayMs, (payload.interval ?? 0) * 1000) + 5000
          } else if (payload.error !== "authorization_pending") {
            return yield* new XaiAuthError({
              reason: "DeviceFlowFailed",
              message: `xAI device authorization failed: ${payload.error}`,
            })
          }
          yield* Effect.sleep(delayMs + 3000)
        }
      })
      return yield* poll.pipe(
        Effect.timeoutOrElse({
          duration:
            (device.expires_in > 0
              ? device.expires_in
              : DEFAULT_DEVICE_EXPIRY_SECONDS) * 1000,
          orElse: () =>
            Effect.fail(
              new XaiAuthError({
                reason: "DeviceFlowFailed",
                message: "xAI device authorization failed: expired_token",
              }),
            ),
        }),
      )
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof XaiAuthError
          ? cause
          : new XaiAuthError({
              reason: "DeviceFlowFailed",
              message: "Failed to authorize xAI device",
              cause,
            }),
      ),
    )

    const refreshToken = Effect.fn("XaiAuth.refreshToken")(
      function* (refresh: string) {
        const response = yield* HttpClientRequest.post(TOKEN_URL).pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: refresh,
          }),
          httpClient.execute,
          Effect.flatMap(HttpClientResponse.filterStatusOk),
        )
        return toTokenData(
          yield* HttpClientResponse.schemaBodyJson(TokenResponse)(response),
          refresh,
        )
      },
      Effect.mapError(
        (cause) =>
          new XaiAuthError({
            reason: "RefreshFailed",
            message: "Failed to refresh xAI access token",
            cause,
          }),
      ),
    )

    const authenticate = Effect.uninterruptibleMask(
      Effect.fnUntraced(function* (restore) {
        return yield* saveToken(yield* restore(authenticateWithDeviceFlow))
      }),
    )
    const get = Effect.uninterruptibleMask(
      Effect.fnUntraced(function* (restore) {
        if (Option.isSome(currentToken)) {
          if (!currentToken.value.isExpired()) return currentToken.value
          const refreshed = yield* restore(
            refreshToken(currentToken.value.refresh).pipe(Effect.option),
          )
          if (Option.isSome(refreshed)) return yield* saveToken(refreshed.value)
          yield* clearToken
        }
        return yield* saveToken(yield* restore(authenticateWithDeviceFlow))
      }),
    )
    return XaiAuth.of({
      get: semaphore.withPermit(get),
      authenticate: semaphore.withPermit(authenticate),
      logout: semaphore.withPermit(Effect.uninterruptible(clearToken)),
    })
  })

  static readonly layer = Layer.effect(XaiAuth, XaiAuth.make)
  static readonly layerClient = Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const auth = yield* XaiAuth
      return (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequestEffect((request) =>
          auth.get.pipe(
            Effect.map((token) =>
              request.pipe(
                HttpClientRequest.bearerToken(token.access),
                HttpClientRequest.setHeader("User-Agent", "clanka"),
              ),
            ),
            Effect.orDie,
          ),
        ),
      )
    }),
  ).pipe(Layer.provide(XaiAuth.layer))
}

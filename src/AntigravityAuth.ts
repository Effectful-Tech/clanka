/**
 * Signs in to Google Antigravity with a Google account, and finds the Cloud
 * Code project its requests run in.
 *
 * @since 1.0.0
 */
/** @effect-diagnostics schemaNumber:off */
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import { OAuthCallback } from "./OAuthCallback.ts"

// The OAuth client of the Antigravity CLI, overridable via environment.
const DEFAULT_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
const DEFAULT_CLIENT_SECRET = "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"

const OAuthClient = Config.all({
  id: Config.String("CLANKA_ANTIGRAVITY_CLIENT_ID").pipe(
    Config.withDefault(DEFAULT_CLIENT_ID),
  ),
  secret: Config.Redacted("CLANKA_ANTIGRAVITY_CLIENT_SECRET").pipe(
    Config.withDefault(Redacted.make(DEFAULT_CLIENT_SECRET)),
  ),
})
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/aicode",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
]
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const REDIRECT_URI = "http://localhost:51121/oauth-callback"
const DEFAULT_TOKEN_EXPIRY_SECONDS = 3600
const IDE_VERSION = "2.29.0"

/**
 * The Cloud Code API Antigravity uses.
 *
 * @since 1.0.0
 * @category Constants
 */
export const API_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal"

/**
 * The user agent of the Antigravity app. Cloud Code serves newer models only
 * to recent app versions.
 *
 * @since 1.0.0
 * @category Constants
 */
export const USER_AGENT = `antigravity/hub/${IDE_VERSION} (aidev_client; os_type=darwin; arch=arm64; cl=1013060670)`

/**
 * @since 1.0.0
 * @category Models
 */
export class TokenData extends Schema.Class<TokenData>(
  "clanka/AntigravityAuth/TokenData",
)({
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Number,
  /**
   * The Cloud Code project the account's requests run in.
   */
  project: Schema.String,
}) {
  isExpired(): boolean {
    return this.expires < Date.now() + 60_000
  }
}

/**
 * @since 1.0.0
 * @category Errors
 */
export class AntigravityAuthError extends Schema.TaggedError<AntigravityAuthError>()(
  "AntigravityAuthError",
  {
    reason: Schema.Literals(["LoginFailed", "RefreshFailed"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
})

const ProjectRef = Schema.Union([
  Schema.String,
  Schema.Struct({ id: Schema.String }),
])
// Cloud Code names the project in any of these fields, as an id or as
// `{ id }`.
const ProjectFields = Schema.Struct({
  cloudaicompanionProject: Schema.optional(ProjectRef),
  projectId: Schema.optional(ProjectRef),
  project: Schema.optional(ProjectRef),
})
const projectOf = (fields: typeof ProjectFields.Type | undefined) =>
  [fields?.cloudaicompanionProject, fields?.projectId, fields?.project]
    .map((ref) => (typeof ref === "object" ? ref.id : ref)?.trim())
    .find((id) => id !== undefined && id !== "")

const LoadCodeAssistResponse = Schema.Struct({
  ...ProjectFields.fields,
  allowedTiers: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        isDefault: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
  currentTier: Schema.optional(Schema.Struct({ id: Schema.String })),
})

const OnboardUserResponse = Schema.Struct({
  done: Schema.optional(Schema.Boolean),
  response: Schema.optional(ProjectFields),
})

/**
 * @since 1.0.0
 * @category Storage
 */
export const toTokenStore = (store: KeyValueStore.KeyValueStore) =>
  KeyValueStore.toSchemaStore(
    KeyValueStore.prefix(store, "antigravity.auth/"),
    TokenData,
  )

/**
 * @since 1.0.0
 * @category Services
 */
export class AntigravityAuth extends Context.Service<
  AntigravityAuth,
  {
    readonly get: Effect.Effect<TokenData, AntigravityAuthError>
    readonly authenticate: Effect.Effect<TokenData, AntigravityAuthError>
    readonly logout: Effect.Effect<void>
  }
>()("clanka/AntigravityAuth") {
  static readonly make = Effect.gen(function* () {
    const callback = yield* OAuthCallback
    const tokenStore = toTokenStore(yield* KeyValueStore.KeyValueStore)
    const httpClient = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(
        HttpClientRequest.setHeader("User-Agent", USER_AGENT),
      ),
      HttpClient.filterStatusOk,
      HttpClient.retryTransient({
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

    const oauthClient = OAuthClient.parse(yield* ConfigProvider.ConfigProvider)
    const requestToken = (params: Record<string, string>) =>
      Effect.flatMap(oauthClient, (client) =>
        HttpClientRequest.post(TOKEN_URL).pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: client.id,
            client_secret: Redacted.value(client.secret),
            ...params,
          }),
          httpClient.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(TokenResponse)),
        ),
      )

    const cloudCode = <S extends Schema.Top>(
      method: string,
      access: string,
      body: unknown,
      schema: S,
    ) =>
      HttpClientRequest.post(`${API_URL}:${method}`).pipe(
        HttpClientRequest.bearerToken(access),
        HttpClientRequest.bodyJsonUnsafe(body),
        httpClient.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      )

    // An account without a project is onboarded onto its default tier,
    // which creates one.
    const findProject = Effect.fnUntraced(function* (access: string) {
      const loaded = yield* cloudCode(
        "loadCodeAssist",
        access,
        { metadata: { ideType: "ANTIGRAVITY" } },
        LoadCodeAssistResponse,
      )
      const existing = projectOf(loaded)
      if (existing !== undefined) return existing
      const tier =
        loaded.allowedTiers?.find((tier) => tier.isDefault)?.id ??
        loaded.currentTier?.id ??
        "free-tier"
      const onboard = cloudCode(
        "onboardUser",
        access,
        {
          tier_id: tier,
          metadata: {
            ide_type: "ANTIGRAVITY",
            ide_version: IDE_VERSION,
            ide_name: "antigravity",
          },
        },
        OnboardUserResponse,
      )
      const onboarded = yield* onboard.pipe(
        Effect.repeat({
          until: (response) => response.done === true,
          schedule: Schedule.spaced("2 seconds"),
          times: 4,
        }),
      )
      const project = projectOf(onboarded.response)
      if (onboarded.done !== true || project === undefined) {
        return yield* new AntigravityAuthError({
          reason: "LoginFailed",
          message:
            "Antigravity did not set up a Cloud Code project for this account",
        })
      }
      return project
    })

    const login = Effect.gen(function* () {
      const client = yield* oauthClient
      const state = crypto.randomUUID()
      const url = new URL(AUTH_URL)
      url.search = new URLSearchParams({
        access_type: "offline",
        client_id: client.id,
        prompt: "consent",
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: SCOPES.join(" "),
        state,
      }).toString()
      const params = yield* callback.receive({
        url: url.toString(),
        redirectUri: REDIRECT_URI,
      })
      const code = params.get("code")
      if (params.get("state") !== state || code === null) {
        return yield* new AntigravityAuthError({
          reason: "LoginFailed",
          message: `Google sign-in failed: ${params.get("error") ?? "invalid state"}`,
        })
      }
      const token = yield* requestToken({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      })
      return new TokenData({
        access: token.access_token,
        refresh: token.refresh_token ?? "",
        expires: expiresAt(token),
        project: yield* findProject(token.access_token),
      })
    }).pipe(orAuthError("LoginFailed", "Failed to sign in to Antigravity"))

    // None when Google rejects the refresh token, which only signing in
    // again fixes. Any other failure keeps the token for the next attempt.
    const refreshToken = Effect.fn("AntigravityAuth.refreshToken")(
      function* (token: TokenData) {
        const refreshed = yield* requestToken({
          grant_type: "refresh_token",
          refresh_token: token.refresh,
        }).pipe(
          Effect.asSome,
          Effect.catchTag("HttpClientError", (error) =>
            Effect.flatMap(grantRejected(error), (rejected) =>
              rejected ? Effect.succeedNone : Effect.fail(error),
            ),
          ),
        )
        return Option.map(
          refreshed,
          (refreshed) =>
            new TokenData({
              access: refreshed.access_token,
              refresh: refreshed.refresh_token ?? token.refresh,
              expires: expiresAt(refreshed),
              project: token.project,
            }),
        )
      },
      orAuthError(
        "RefreshFailed",
        "Failed to refresh the Antigravity access token",
      ),
    )

    const authenticate = Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(restore(login), saveToken),
    )
    const get = Effect.uninterruptibleMask(
      Effect.fnUntraced(function* (restore) {
        if (Option.isSome(currentToken)) {
          if (!currentToken.value.isExpired()) return currentToken.value
          const refreshed = yield* restore(refreshToken(currentToken.value))
          if (Option.isSome(refreshed)) return yield* saveToken(refreshed.value)
          yield* clearToken
        }
        return yield* saveToken(yield* restore(login))
      }),
    )
    return AntigravityAuth.of({
      get: semaphore.withPermit(get),
      authenticate: semaphore.withPermit(authenticate),
      logout: semaphore.withPermit(Effect.uninterruptible(clearToken)),
    })
  })

  static readonly layer = Layer.effect(AntigravityAuth, AntigravityAuth.make)
}

const orAuthError = (reason: AntigravityAuthError["reason"], message: string) =>
  Effect.mapError((cause: unknown) =>
    cause instanceof AntigravityAuthError
      ? cause
      : new AntigravityAuthError({ reason, message, cause }),
  )

// Google answers `invalid_grant` to a revoked or expired refresh token.
const grantRejected = (error: HttpClientError.HttpClientError) =>
  error.reason._tag === "StatusCodeError" &&
  error.reason.response.status === 400
    ? error.reason.response.json.pipe(
        Effect.map(
          (body) => Predicate.isObject(body) && body.error === "invalid_grant",
        ),
        Effect.orElseSucceed(() => false),
      )
    : Effect.succeed(false)

const expiresAt = (token: typeof TokenResponse.Type) =>
  Date.now() + (token.expires_in ?? DEFAULT_TOKEN_EXPIRY_SECONDS) * 1000

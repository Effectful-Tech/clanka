/**
 * Receives the redirect of an OAuth authorization code flow on a loopback
 * HTTP server.
 *
 * @since 1.0.0
 */
import * as Http from "node:http"
import * as Console from "effect/Console"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

/**
 * @since 1.0.0
 * @category Errors
 */
export class OAuthCallbackError extends Schema.TaggedError<OAuthCallbackError>()(
  "OAuthCallbackError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * @since 1.0.0
 * @category Services
 */
export class OAuthCallback extends Context.Service<
  OAuthCallback,
  {
    /**
     * Shows `url` to the user, then waits for the browser to be redirected
     * to `redirectUri`, a loopback URL, and returns the query parameters of
     * that redirect.
     */
    receive(options: {
      readonly url: string
      readonly redirectUri: string
    }): Effect.Effect<URLSearchParams, OAuthCallbackError>
  }
>()("clanka/OAuthCallback") {}

/**
 * Listens on the port of the redirect URI until the first request to its
 * path that carries a `code` or an `error`, for at most five minutes.
 * `notify` shows the authorization URL to the user.
 *
 * @since 1.0.0
 * @category Layers
 */
export const layerLoopback = (notify: (url: string) => Effect.Effect<void>) =>
  Layer.succeed(OAuthCallback, {
    receive: ({ url, redirectUri }) =>
      Effect.gen(function* () {
        const redirect = new URL(redirectUri)
        const received = yield* Deferred.make<URLSearchParams>()
        yield* Effect.acquireRelease(
          Effect.callback<Http.Server, OAuthCallbackError>((resume) => {
            const server = Http.createServer((request, response) => {
              const target = new URL(request.url ?? "/", redirect)
              const params = target.searchParams
              if (
                target.pathname !== redirect.pathname ||
                (!params.has("code") && !params.has("error"))
              ) {
                response.writeHead(404).end()
                return
              }
              response
                .writeHead(200, { "content-type": "text/plain" })
                .end("Signed in. You can close this window.")
              Deferred.doneUnsafe(received, Effect.succeed(params))
            })
            server.once("error", (cause) =>
              resume(
                Effect.fail(
                  new OAuthCallbackError({
                    message: `Could not listen on port ${redirect.port} for the sign-in redirect`,
                    cause,
                  }),
                ),
              ),
            )
            server.listen(Number(redirect.port), redirect.hostname, () =>
              resume(Effect.succeed(server)),
            )
          }),
          (server) =>
            Effect.callback<void>((resume) => {
              server.close(() => resume(Effect.void))
              server.closeAllConnections()
            }),
        )
        yield* notify(url)
        return yield* Deferred.await(received).pipe(
          Effect.timeoutOrElse({
            duration: "5 minutes",
            orElse: () =>
              Effect.fail(
                new OAuthCallbackError({
                  message: "Timed out waiting for the sign-in redirect",
                }),
              ),
          }),
        )
      }).pipe(Effect.scoped),
  })

/**
 * @since 1.0.0
 * @category Layers
 */
export const layerConsole = layerLoopback((url) =>
  Console.log(`Open ${url} to sign in.`),
)

/**
 * @since 1.0.0
 * @category Layers
 */
export const layerLog = layerLoopback((url) =>
  Effect.logWarning(`Open ${url} to sign in.`),
)

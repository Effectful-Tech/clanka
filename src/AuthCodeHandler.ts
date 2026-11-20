/**
 * Prompts the user to sign in in a browser and paste back an OAuth
 * authorization code.
 *
 * @since 1.0.0
 */
import * as Prompt from "effect/cli/Prompt"
import * as Console from "effect/Console"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

/**
 * @since 1.0.0
 * @category Errors
 */
export class AuthCodeHandlerError extends Schema.TaggedError<AuthCodeHandlerError>()(
  "AuthCodeHandlerError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * @since 1.0.0
 * @category Services
 */
export class AuthCodeHandler extends Context.Service<
  AuthCodeHandler,
  {
    /**
     * Shows `url` to the user and returns the pasted authorization code.
     */
    request(options: {
      readonly url: string
    }): Effect.Effect<string, AuthCodeHandlerError>
  }
>()("clanka/AuthCodeHandler") {}

const signInMessage =
  "Sign in to Antigravity by running `clanka --provider antigravity` in an interactive terminal."

/**
 * Prints the authorization URL and reads the pasted code from the terminal.
 * Fails immediately when stdin is not a terminal.
 *
 * @since 1.0.0
 * @category Layers
 */
export const layerPrompt: Layer.Layer<
  AuthCodeHandler,
  never,
  Prompt.Environment
> = Layer.effect(
  AuthCodeHandler,
  Effect.gen(function* () {
    const context = yield* Effect.context<Prompt.Environment>()
    return AuthCodeHandler.of({
      request: ({ url }) =>
        Effect.gen(function* () {
          if (process.stdin.isTTY !== true) {
            return yield* new AuthCodeHandlerError({ message: signInMessage })
          }
          yield* Console.log(`Open ${url} to sign in.`)
          return yield* Prompt.Password({
            message: "Paste the authorization code",
          }).pipe(
            Effect.map(Redacted.value),
            Effect.provideContext(context),
            Effect.mapError(
              (cause) =>
                new AuthCodeHandlerError({
                  message: "Sign-in cancelled",
                  cause,
                }),
            ),
          )
        }),
    })
  }),
)

/**
 * Fails every sign-in attempt with instructions to sign in from an
 * interactive terminal first, for modes such as `clanka acp` that own stdin.
 *
 * @since 1.0.0
 * @category Layers
 */
export const layerUnavailable: Layer.Layer<AuthCodeHandler> = Layer.succeed(
  AuthCodeHandler,
  {
    request: () =>
      Effect.fail(new AuthCodeHandlerError({ message: signInMessage })),
  },
)

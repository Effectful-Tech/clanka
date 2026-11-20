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
import * as Stdio from "effect/Stdio"

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

const unavailable = (message: string) =>
  AuthCodeHandler.of({
    request: () => Effect.fail(new AuthCodeHandlerError({ message })),
  })

/**
 * Prints the authorization URL and reads the pasted code, masked, from the
 * terminal. Every sign-in fails when stdin is not a terminal.
 *
 * @since 1.0.0
 * @category Layers
 */
export const layerPrompt: Layer.Layer<
  AuthCodeHandler,
  never,
  Prompt.Environment | Stdio.Stdio
> = Layer.effect(
  AuthCodeHandler,
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    if (!(yield* stdio.stdinIsTerminal)) {
      return unavailable("Sign-in needs an interactive terminal")
    }
    const context = yield* Effect.context<Prompt.Environment>()
    return AuthCodeHandler.of({
      request: ({ url }) =>
        Console.log(`Open ${url} to sign in.`).pipe(
          Effect.andThen(
            Prompt.Password({ message: "Paste the authorization code" }),
          ),
          Effect.map(Redacted.value),
          Effect.mapError(
            () => new AuthCodeHandlerError({ message: "Sign-in cancelled" }),
          ),
          Effect.provideContext(context),
        ),
    })
  }),
)

/**
 * Fails every sign-in with `message`, for modes such as `clanka acp` that
 * own stdin and cannot ask for a code.
 *
 * @since 1.0.0
 * @category Layers
 */
export const layerUnavailable = (message: string) =>
  Layer.succeed(AuthCodeHandler, unavailable(message))

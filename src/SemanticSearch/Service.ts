/**
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Context from "effect/Context"

/**
 * @since 1.0.0
 * @category Services
 */
export class SemanticSearch extends Context.Service<
  SemanticSearch,
  {
    search(options: {
      readonly query: string
      readonly limit: number
    }): Effect.Effect<string>
    updateFile(path: string): Effect.Effect<void>
    removeFile(path: string): Effect.Effect<void>
  }
>()("clanka/SemanticSearch/SemanticSearch") {}

/**
 * @since 1.0.0
 * @category Utils
 */
export const maybeUpdateFile = (path: string): Effect.Effect<void> =>
  Effect.serviceOption(SemanticSearch).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (service) => service.updateFile(path),
      }),
    ),
  )

/**
 * @since 1.0.0
 * @category Utils
 */
export const maybeRemoveFile = (path: string): Effect.Effect<void> =>
  Effect.serviceOption(SemanticSearch).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (service) => service.removeFile(path),
      }),
    ),
  )

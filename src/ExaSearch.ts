/**
 * @since 1.0.0
 */
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { pipe } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Context from "effect/Context"

/**
 * @since 1.0.0
 * @category Services
 */
export class ExaSearch extends Context.Service<
  ExaSearch,
  {
    search(
      options: typeof ExaSearchOptions.Type,
    ): Effect.Effect<string, ExaError>
  }
>()("clanka/ExaSearch") {}

/**
 * @since 1.0.0
 * @category Schemas
 */
export const ExaSearchOptions = Schema.Struct({
  query: Schema.String,
  // @effect-diagnostics-next-line schemaNumber:off
  numResults: Schema.optional(Schema.Number).annotate({
    documentation: "The number of search results to return. Defaults to 3.",
  }),
})

class ExaSearchResult extends Schema.Class<ExaSearchResult>("ExaSearchResult")({
  type: Schema.Literal("text"),
  text: Schema.String,
}) {}

/**
 * @since 1.0.0
 * @category Errors
 */
export class ExaError extends Schema.TaggedError<ExaError>()("ExaError", {
  cause: Schema.Defect(),
}) {}

/**
 * @since 1.0.0
 * @category Layers
 */
export const layer = Layer.effect(
  ExaSearch,
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const getClient = yield* Effect.cachedWithTTL(
      Effect.gen(function* () {
        const McpClient = yield* Effect.tryPromise(
          () => import("./McpClient.ts"),
        )
        const context = yield* Layer.buildWithScope(McpClient.layer, scope)
        return Context.get(context, McpClient.McpClient)
      }),
      (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    )

    const connect = yield* Effect.cachedWithTTL(
      Effect.gen(function* () {
        const client = yield* getClient
        yield* client.connect({ url: "https://mcp.exa.ai/mcp" })
        return client
      }),
      (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    )

    const decode = Schema.decodeUnknownEffect(
      Schema.NonEmptyArray(ExaSearchResult),
    )

    return ExaSearch.of({
      search: Effect.fn("ExaSearch.search")(
        function* (options) {
          const client = yield* connect
          const results = yield* pipe(
            client.toolCall({
              name: "web_search_exa",
              arguments: {
                query: options.query,
                num_results: options.numResults ?? 3,
              },
            }),
            Effect.flatMap(decode),
          )
          return results[0].text
        },
        Effect.mapError((cause) => new ExaError({ cause })),
      ),
    })
  }),
)

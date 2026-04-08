/**
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import { pipe } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Context from "effect/Context"
import * as McpClient from "./McpClient.ts"

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
export class ExaError extends Schema.TaggedErrorClass<ExaError>()("ExaError", {
  cause: Schema.Defect,
}) {}

/**
 * @since 1.0.0
 * @category Layers
 */
export const layer = Layer.effect(
  ExaSearch,
  Effect.gen(function* () {
    const client = yield* McpClient.McpClient

    yield* client.connect({ url: "https://mcp.exa.ai/mcp" }).pipe(Effect.orDie)

    const decode = Schema.decodeUnknownEffect(
      Schema.NonEmptyArray(ExaSearchResult),
    )

    return ExaSearch.of({
      search: Effect.fn("ExaSearch.search")(
        function* (options) {
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
).pipe(Layer.provide(McpClient.layer))

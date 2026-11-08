/**
 * The chat models a GitHub Copilot account can run, read from the
 * authenticated `/models` catalog. Copilot has its own model ids, reasoning
 * efforts and per-model API endpoints, and enables models per account, so
 * neither models.dev nor the built-in catalog can stand in for it.
 *
 * @since 1.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { ThoughtLevel } from "./Acp.ts"
import { API_URL, GithubCopilotAuth } from "./CopilotAuth.ts"
import { ModelInfo } from "./ModelsRepo.ts"

/**
 * The APIs clanka speaks to Copilot, most capable first.
 *
 * @since 1.0.0
 * @category Models
 */
export const Endpoint = Schema.Literals(["/responses", "/chat/completions"])

/**
 * @since 1.0.0
 * @category Models
 */
export type Endpoint = typeof Endpoint.Type

/**
 * @since 1.0.0
 * @category Models
 */
export interface CopilotModel extends ModelInfo {
  /**
   * The API the model is served on.
   */
  readonly endpoint: Endpoint
}

/**
 * @since 1.0.0
 * @category Errors
 */
export class CopilotModelsError extends Schema.TaggedError<CopilotModelsError>()(
  "CopilotModelsError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

// The fields of a `/models` entry the catalog reads. Entries are decoded one
// by one, so a malformed entry drops that model only.
const RemoteModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  model_picker_enabled: Schema.optionalKey(Schema.Boolean),
  supported_endpoints: Schema.optionalKey(Schema.Array(Schema.String)),
  policy: Schema.optionalKey(
    Schema.Struct({ state: Schema.optionalKey(Schema.String) }),
  ),
  capabilities: Schema.Struct({
    supports: Schema.Struct({
      tool_calls: Schema.optionalKey(Schema.Boolean),
      reasoning_effort: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  }),
})

const Catalog = Schema.Struct({ data: Schema.Array(Schema.Unknown) })

const decodeModel = Schema.decodeUnknownOption(RemoteModel)
const isThoughtLevel = Schema.is(ThoughtLevel)

const toCatalog = (data: ReadonlyArray<unknown>): Array<CopilotModel> =>
  data.flatMap((entry) => {
    const model = Option.getOrUndefined(decodeModel(entry))
    if (model === undefined) return []
    // Copilot can hide every model from its picker, including those the
    // account policy enables, so the picker flag only counts for models
    // without an explicit policy.
    const enabled =
      model.policy?.state === "enabled" ||
      (model.policy?.state !== "disabled" &&
        model.model_picker_enabled !== false)
    const endpoints = model.supported_endpoints ?? ["/chat/completions"]
    const endpoint = Endpoint.literals.find((e) => endpoints.includes(e))
    if (
      !enabled ||
      model.capabilities.supports.tool_calls !== true ||
      endpoint === undefined
    ) {
      return []
    }
    return [
      {
        ...new ModelInfo({
          provider: "copilot",
          id: model.id,
          name: model.name,
          efforts: (model.capabilities.supports.reasoning_effort ?? []).filter(
            isThoughtLevel,
          ),
        }),
        endpoint,
      },
    ]
  })

/**
 * @since 1.0.0
 * @category Services
 */
export class CopilotModels extends Context.Service<
  CopilotModels,
  {
    /**
     * The models the account can run, in catalog order: enabled for the
     * account, accepting tool calls and served on an `Endpoint`. Fails when
     * the catalog cannot be read or lists no such model.
     */
    readonly models: Effect.Effect<
      ReadonlyArray<CopilotModel>,
      CopilotModelsError
    >
    /**
     * The catalog entry for a model id. Fails naming the available ids.
     */
    readonly get: (
      id: string,
    ) => Effect.Effect<CopilotModel, CopilotModelsError>
  }
>()("clanka/CopilotModels") {
  /**
   * Reads the catalog over the `HttpClient` in context, which must send the
   * Copilot credentials. Makes no request until a model is asked for.
   *
   * @since 1.0.0
   * @category Layers
   */
  static readonly layer = Layer.effect(
    CopilotModels,
    Effect.gen(function* () {
      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      const models = yield* Effect.cached(
        http.get(API_URL + "/models").pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Catalog)),
          Effect.mapError(
            (cause) =>
              new CopilotModelsError({
                message: "Failed to load the Copilot model catalog",
                cause,
              }),
          ),
          Effect.flatMap(({ data }) => {
            const catalog = toCatalog(data)
            return catalog.length === 0
              ? new CopilotModelsError({
                  message:
                    "Copilot advertises no supported tool-calling models for this account",
                })
              : Effect.succeed(catalog)
          }),
        ),
      )
      const get = Effect.fn("CopilotModels.get")(function* (id: string) {
        const catalog = yield* models
        const model = catalog.find((model) => model.id === id)
        if (model === undefined) {
          return yield* new CopilotModelsError({
            message: `Copilot does not advertise model "${id}" for this account. Available model IDs: ${catalog.map((model) => model.id).join(", ")}`,
          })
        }
        return model
      })
      return CopilotModels.of({ models, get })
    }),
  )

  /**
   * `layer` over the authenticated Copilot client. Asking for a model signs
   * the user in when no token is stored.
   *
   * @since 1.0.0
   * @category Layers
   */
  static readonly layerAuthenticated = this.layer.pipe(
    Layer.provide(GithubCopilotAuth.layerClient),
  )

  /**
   * The account's models, read through `layerAuthenticated`.
   *
   * @since 1.0.0
   * @category Models
   */
  static readonly account = CopilotModels.use((repo) => repo.models).pipe(
    Effect.provide(this.layerAuthenticated),
  )
}

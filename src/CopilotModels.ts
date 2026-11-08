import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { HttpClient, HttpClientResponse } from "effect/http"
import { API_URL, GithubCopilotAuth } from "./CopilotAuth.ts"
import { ModelInfo } from "./ModelsRepo.ts"
import { ThoughtLevel } from "./Acp.ts"

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
const decodeModel = Schema.decodeUnknownOption(RemoteModel)
const isThoughtLevel = Schema.is(ThoughtLevel)

export interface CopilotModel extends ModelInfo {
  readonly endpoint: "/responses" | "/chat/completions"
}

export class CopilotModelsError extends Schema.TaggedError<CopilotModelsError>()(
  "CopilotModelsError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export class CopilotModels extends Context.Service<
  CopilotModels,
  {
    readonly models: Effect.Effect<
      ReadonlyArray<CopilotModel>,
      CopilotModelsError
    >
  }
>()("clanka/CopilotModels") {
  static readonly layer = Layer.effect(
    CopilotModels,
    Effect.gen(function* () {
      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      const models = yield* Effect.cached(
        http.get(API_URL + "/models").pipe(
          Effect.flatMap(
            HttpClientResponse.schemaBodyJson(
              Schema.Struct({ data: Schema.Array(Schema.Unknown) }),
            ),
          ),
          Effect.map(({ data }) =>
            data.flatMap((entry): Array<CopilotModel> => {
              const model = Option.getOrUndefined(decodeModel(entry))
              if (
                !model ||
                model.model_picker_enabled === false ||
                model.policy?.state === "disabled" ||
                model.capabilities.supports.tool_calls !== true
              )
                return []
              const endpoints = model.supported_endpoints ?? [
                "/chat/completions",
              ]
              const endpoint = endpoints.includes("/responses")
                ? "/responses"
                : endpoints.includes("/chat/completions")
                  ? "/chat/completions"
                  : undefined
              if (endpoint === undefined) return []
              return [
                {
                  ...new ModelInfo({
                    provider: "copilot",
                    id: model.id,
                    name: model.name,
                    efforts: (
                      model.capabilities.supports.reasoning_effort ?? []
                    ).filter(isThoughtLevel),
                  }),
                  endpoint,
                },
              ]
            }),
          ),
          Effect.mapError(
            (cause) =>
              new CopilotModelsError({
                message:
                  "Failed to load the authenticated Copilot model catalog",
                cause,
              }),
          ),
        ),
      )
      return CopilotModels.of({ models })
    }),
  )

  static readonly layerAuthenticated = this.layer.pipe(
    Layer.provide(GithubCopilotAuth.layerClient),
  )
}

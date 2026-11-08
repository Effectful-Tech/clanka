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

const endpointFor = (model: typeof RemoteModel.Type) => {
  const endpoints = model.supported_endpoints ?? ["/chat/completions"]
  return endpoints.includes("/responses")
    ? ("/responses" as const)
    : endpoints.includes("/chat/completions")
      ? ("/chat/completions" as const)
      : undefined
}

const rejectionReason = (model: typeof RemoteModel.Type) => {
  if (model.policy?.state === "disabled") return "policy_disabled"
  // Copilot can mark every model as hidden even when policy explicitly allows it.
  if (model.model_picker_enabled === false && model.policy?.state !== "enabled")
    return "picker_hidden_without_enabled_policy"
  if (model.capabilities.supports.tool_calls !== true)
    return "tool_calls_not_true"
  if (endpointFor(model) === undefined) return "unsupported_endpoint"
  return "accepted"
}

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown))
const field = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined

// Only booleans and a fixed vocabulary may appear as values. In particular,
// never echo model IDs, names, unknown fields, headers, or schema error inputs.
const diagnosticValue = (value: unknown): unknown => {
  if (typeof value === "boolean") return value
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}
const diagnosticEnum = (value: unknown, allowed: ReadonlyArray<string>) =>
  typeof value === "string" && allowed.includes(value)
    ? value
    : diagnosticValue(value)
const diagnosticArray = (value: unknown, allowed: ReadonlyArray<string>) =>
  Array.isArray(value)
    ? value.map((item) => diagnosticEnum(item, allowed))
    : diagnosticValue(value)

/** A credential-free shape report for investigating rejected catalog entries. */
export const diagnoseCatalog = Effect.gen(function* () {
  const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  const response = yield* http.get(API_URL + "/models")
  const { data } = yield* HttpClientResponse.schemaBodyJson(
    Schema.Struct({ data: Schema.Array(Schema.Unknown) }),
  )(response)
  return {
    count: data.length,
    entries: data.map((entry) => {
      const decoded = decodeModel(entry)
      const capabilities = field(entry, "capabilities")
      const supports = field(capabilities, "supports")
      const policy = field(entry, "policy")
      return {
        decodes: Option.isSome(decoded),
        eligibility: Option.isSome(decoded)
          ? rejectionReason(decoded.value)
          : "decode_failed",
        id: diagnosticValue(field(entry, "id")),
        name: diagnosticValue(field(entry, "name")),
        model_picker_enabled: diagnosticValue(
          field(entry, "model_picker_enabled"),
        ),
        supported_endpoints: diagnosticArray(
          field(entry, "supported_endpoints"),
          ["/responses", "/chat/completions", "/v1/messages"],
        ),
        policy: diagnosticValue(policy),
        policy_state: diagnosticEnum(field(policy, "state"), [
          "enabled",
          "disabled",
          "unconfigured",
        ]),
        capabilities: diagnosticValue(capabilities),
        supports: diagnosticValue(supports),
        tool_calls: diagnosticValue(field(supports, "tool_calls")),
        reasoning_effort: diagnosticArray(
          field(supports, "reasoning_effort"),
          ThoughtLevel.literals,
        ),
      }
    }),
  }
})

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
              if (model === undefined || rejectionReason(model) !== "accepted")
                return []
              const endpoint = endpointFor(model)
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

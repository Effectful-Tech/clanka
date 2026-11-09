/**
 * The `openai-compat` provider: any OpenAI-compatible chat completions
 * endpoint, such as a model proxy, through `@effect/ai-openai-compat`.
 *
 * @since 1.0.0
 */
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Struct from "effect/Struct"
import type * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import { AgentModelConfig } from "./Agent.ts"
import * as Compaction from "./Compaction.ts"
import * as ModelsRepo from "./ModelsRepo.ts"

/**
 * The client for an endpoint. Without `apiUrl` it talks to
 * `https://api.openai.com/v1`.
 *
 * @since 1.0.0
 * @category Layers
 */
export const layerClient = (
  options: OpenAiClient.Options,
): Layer.Layer<OpenAiClient.OpenAiClient, never, HttpClient.HttpClient> =>
  OpenAiClient.layer(options)

/**
 * Options for a model. The effort of `reasoning` is sent as the chat
 * completions `reasoning_effort`; `reasoning: null` or no effort sends no
 * reasoning options, which keeps the endpoint's default.
 *
 * @since 1.0.0
 * @category Models
 */
export type ModelOptions = OpenAiLanguageModel.Config["Service"] & {
  readonly reasoning?:
    { readonly effort?: string | undefined } | null | undefined
} & typeof AgentModelConfig.Service

/**
 * @since 1.0.0
 * @category Layers
 */
export const model = (
  model: string,
  options?: ModelOptions | undefined,
): Model.Model<
  "openai-compat",
  LanguageModel.LanguageModel,
  OpenAiClient.OpenAiClient
> =>
  Model.make(
    "openai-compat",
    model,
    Layer.mergeAll(
      OpenAiLanguageModel.layer({
        model,
        config: {
          // Chat completions endpoints read `reasoning_effort`; the
          // Responses-style `reasoning` object is ignored or rejected.
          ...Struct.omit(options ?? {}, [
            "reasoning",
            ...AgentModelConfig.optionKeys,
          ]),
          ...(options?.reasoning?.effort === undefined
            ? undefined
            : { reasoning_effort: options.reasoning.effort }),
        },
      }),
      AgentModelConfig.layer(
        Struct.pick(options ?? {}, AgentModelConfig.optionKeys),
      ),
      // Cap compaction summaries; sent as chat completions `max_tokens`.
      Layer.succeed(Compaction.SummarizerTransform, (effect) =>
        OpenAiLanguageModel.withConfigOverride(effect, {
          max_output_tokens: Compaction.summarizerMaxOutputTokens,
        }),
      ),
    ),
  )

// The fields of a `GET /models` response the catalog reads. Entries are
// decoded one by one, so a malformed entry drops that model only.
const ModelsResponse = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
})

const ModelEntry = Schema.Struct({
  id: Schema.String,
  created: Schema.optionalKey(Schema.Finite),
})

const decodeEntry = Schema.decodeUnknownOption(ModelEntry)

/**
 * The models the endpoint lists at `GET /models`, newest first, as
 * `openai-compat` catalog entries named by their id. The listing carries no
 * reasoning efforts, so the entries have none and run at the endpoint's
 * default effort. Never fails: logs a warning and serves no models when the
 * endpoint cannot be listed.
 *
 * @since 1.0.0
 * @category Models
 */
export const models: Effect.Effect<
  ReadonlyArray<ModelsRepo.ModelInfo>,
  never,
  OpenAiClient.OpenAiClient
> = Effect.gen(function* () {
  const { client } = yield* OpenAiClient.OpenAiClient
  const response = yield* HttpClient.filterStatusOk(client)
    .get("/models")
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(ModelsResponse)))
  return response.data
    .flatMap((entry) => decodeEntry(entry).pipe(Option.toArray))
    .toSorted(
      (a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id),
    )
    .map(
      (entry) =>
        new ModelsRepo.ModelInfo({
          provider: "openai-compat",
          id: entry.id,
          name: entry.id,
          efforts: [],
        }),
    )
}).pipe(
  Effect.timeout("15 seconds"),
  Effect.catch((error) =>
    Effect.logWarning("Failed to list the openai-compat models", error).pipe(
      Effect.as([]),
    ),
  ),
)

/**
 * The `ModelsRepo` in context followed by the models `client` lists at
 * `GET /models`. The endpoint is listed once, on first use.
 *
 * @since 1.0.0
 * @category Layers
 */
export const layerModelsRepo = (
  client: OpenAiClient.Options,
): Layer.Layer<
  ModelsRepo.ModelsRepo,
  never,
  ModelsRepo.ModelsRepo | HttpClient.HttpClient
> =>
  Layer.effect(
    ModelsRepo.ModelsRepo,
    Effect.gen(function* () {
      const repo = yield* ModelsRepo.ModelsRepo
      const listed = yield* Effect.cached(
        Effect.provideService(
          models,
          OpenAiClient.OpenAiClient,
          yield* OpenAiClient.OpenAiClient,
        ),
      )
      return ModelsRepo.ModelsRepo.of({
        models: Effect.zipWith(
          repo.models,
          listed,
          (catalog, compat) => [...catalog, ...compat],
          { concurrent: true },
        ),
      })
    }),
  ).pipe(Layer.provide(layerClient(client)))

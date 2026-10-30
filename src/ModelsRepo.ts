/**
 * The catalog of chat models clanka can run, and a models.dev implementation.
 *
 * See `.specs/models-repo.md`.
 *
 * @since 1.0.0
 */
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Schema from "effect/Schema"
import { ThoughtLevel } from "./Acp.ts"

/**
 * A clanka provider, as `--provider` takes it.
 *
 * @since 1.0.0
 * @category Models
 */
export const Provider = Schema.Literals(["openai", "copilot", "xai", "claude"])

/**
 * @since 1.0.0
 * @category Models
 */
export type Provider = typeof Provider.Type

/**
 * @since 1.0.0
 * @category Models
 */
export class ModelInfo extends Schema.Class<ModelInfo>(
  "clanka/ModelsRepo/ModelInfo",
)({
  provider: Provider,
  /**
   * The model id as the provider API expects it, e.g. `gpt-6-astra`.
   */
  id: Schema.String,
  name: Schema.String,
  /**
   * Reasoning efforts the model accepts; empty when it takes none.
   */
  efforts: Schema.Array(ThoughtLevel),
}) {}

/**
 * The built-in catalog, served when neither models.dev nor a cached catalog
 * is available.
 *
 * @since 1.0.0
 * @category Models
 */
export const fallback: ReadonlyArray<ModelInfo> = [
  new ModelInfo({
    provider: "openai",
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    efforts: ["low", "medium", "high", "xhigh", "max"],
  }),
  new ModelInfo({
    provider: "copilot",
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    efforts: ["low", "medium", "high", "xhigh", "max"],
  }),
  new ModelInfo({
    provider: "xai",
    id: "grok-4.6",
    name: "Grok 4.6",
    efforts: ["low", "medium", "high", "xhigh"],
  }),
  new ModelInfo({
    provider: "claude",
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    efforts: ["low", "medium", "high", "xhigh", "max"],
  }),
]

// The fields of a models.dev model entry the catalog reads. Entries are
// decoded one by one, so a malformed entry drops that model only.
const ModelsDevModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.optionalKey(Schema.String),
  release_date: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  tool_call: Schema.optionalKey(Schema.Boolean),
  reasoning_options: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        type: Schema.String,
        values: Schema.optionalKey(Schema.Array(Schema.Unknown)),
      }),
    ),
  ),
})

const ModelsDevProvider = Schema.Struct({
  models: Schema.Record(Schema.String, Schema.Unknown),
})

// models.dev provider id to clanka provider.
const providerIds: ReadonlyArray<readonly [string, Provider]> = [
  ["openai", "openai"],
  ["github-copilot", "copilot"],
  ["xai", "xai"],
  ["anthropic", "claude"],
]

const ModelsDevApi = Schema.Struct(
  Object.fromEntries(
    providerIds.map(([id]) => [id, Schema.optionalKey(ModelsDevProvider)]),
  ),
)

const decodeModel = Schema.decodeUnknownOption(ModelsDevModel)
const isThoughtLevel = Schema.is(ThoughtLevel)

const toCatalog = (api: typeof ModelsDevApi.Type): ReadonlyArray<ModelInfo> =>
  providerIds
    .flatMap(([id, provider]) =>
      Object.values(api[id]?.models ?? {}).flatMap((entry) => {
        const model = Option.getOrUndefined(decodeModel(entry))
        if (
          model === undefined ||
          model.type !== undefined ||
          model.status === "deprecated" ||
          model.tool_call !== true
        ) {
          return []
        }
        return [{ ...model, provider }]
      }),
    )
    .toSorted(
      (a, b) =>
        (b.release_date ?? "").localeCompare(a.release_date ?? "") ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 10)
    .map((model) => {
      const effort = model.reasoning_options?.find(
        (option) => option.type === "effort",
      )
      return new ModelInfo({
        provider: model.provider,
        id: model.id,
        name: model.name,
        efforts: (effort?.values ?? []).filter(isThoughtLevel),
      })
    })

class CachedCatalog extends Schema.Class<CachedCatalog>(
  "clanka/ModelsRepo/CachedCatalog",
)({
  fetchedAt: Schema.Finite,
  models: Schema.Array(ModelInfo),
}) {}

/**
 * @since 1.0.0
 * @category Services
 */
export class ModelsRepo extends Context.Service<
  ModelsRepo,
  {
    /**
     * Every chat model clanka can run, in catalog order. Never fails: an
     * implementation that cannot reach its source serves what it has.
     */
    readonly models: Effect.Effect<ReadonlyArray<ModelInfo>>
  }
>()("clanka/ModelsRepo") {
  /**
   * A fixed catalog.
   *
   * @since 1.0.0
   * @category Layers
   */
  static readonly layer = (
    models: ReadonlyArray<ModelInfo>,
  ): Layer.Layer<ModelsRepo> =>
    Layer.succeed(ModelsRepo, ModelsRepo.of({ models: Effect.succeed(models) }))

  /**
   * The catalog built from `https://models.dev/api.json`: the `openai`,
   * `github-copilot`, `xai` and `anthropic` (as `claude`) text models that
   * are not deprecated and accept tool calls. Keeps the 10 newest models by
   * release date, then name alphabetically, with undated models last. Cached
   * in the `KeyValueStore` for `ttl` (default 24 hours).
   * Serves the cached catalog when the fetch fails, then `fallback`.
   *
   * @since 1.0.0
   * @category Layers
   */
  static readonly layerModelsDev = (
    options?:
      | {
          readonly url?: string | undefined
          readonly ttl?: Duration.Input | undefined
        }
      | undefined,
  ): Layer.Layer<
    ModelsRepo,
    never,
    HttpClient.HttpClient | KeyValueStore.KeyValueStore
  > =>
    Layer.effect(
      ModelsRepo,
      Effect.gen(function* () {
        const url = options?.url ?? "https://models.dev/api.json"
        const ttl = Duration.toMillis(
          Duration.fromInputUnsafe(options?.ttl ?? Duration.hours(24)),
        )
        const store = KeyValueStore.toSchemaStore(
          KeyValueStore.prefix(
            yield* KeyValueStore.KeyValueStore,
            "models-dev/",
          ),
          CachedCatalog,
        )
        const httpClient = (yield* HttpClient.HttpClient).pipe(
          HttpClient.filterStatusOk,
        )

        const fetchCatalog = httpClient
          .get(url)
          .pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(ModelsDevApi)),
            Effect.map(toCatalog),
            Effect.timeout("15 seconds"),
          )

        const load = Effect.gen(function* () {
          const cached = yield* store.get(url).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.catch(() => Effect.undefined),
          )
          const now = yield* Clock.currentTimeMillis
          if (cached !== undefined && now - cached.fetchedAt < ttl) {
            return cached.models
          }
          return yield* fetchCatalog.pipe(
            Effect.tap((models) =>
              store
                .set(url, new CachedCatalog({ fetchedAt: now, models }))
                .pipe(
                  Effect.catch((error) =>
                    Effect.logWarning(
                      "Failed to cache the models.dev catalog",
                      error,
                    ),
                  ),
                ),
            ),
            Effect.catch((error) =>
              Effect.logWarning(
                cached !== undefined
                  ? "Failed to refresh the models.dev catalog, using the cached catalog"
                  : "Failed to fetch the models.dev catalog, using the built-in catalog",
                error,
              ).pipe(Effect.as(cached?.models ?? fallback)),
            ),
          )
        })

        return ModelsRepo.of({ models: yield* Effect.cached(load) })
      }),
    )
}

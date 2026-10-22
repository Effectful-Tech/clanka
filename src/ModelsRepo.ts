/**
 * The catalog of chat models clanka can run, and a models.dev implementation.
 *
 * See `.specs/models-repo.md`.
 *
 * @since 1.0.0
 */
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import type * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Schema from "effect/Schema"
import { ThoughtLevel } from "./Acp.ts"

/**
 * A clanka provider, as `--provider` takes it.
 *
 * @since 1.0.0
 * @category Models
 */
export const Provider = Schema.Literals(["openai", "copilot", "xai"])

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
]

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
   * `github-copilot` and `xai` text models that are not deprecated and accept
   * tool calls, cached in the `KeyValueStore` for `ttl` (default 24 hours).
   * Serves the cached catalog when the fetch fails, then `fallback`.
   *
   * @since 1.0.0
   * @category Layers
   */
  static readonly layerModelsDev = (
    _options?:
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
    // TODO(EFF-2790): production implementation lands in a follow-up run.
    Layer.effect(
      ModelsRepo,
      Effect.die(new Error("ModelsRepo.layerModelsDev is not implemented")),
    )
}

/**
 * Builds the model layers the `clanka` CLI runs, for the interactive prompt
 * and for `clanka acp`.
 *
 * @since 1.0.0
 */
import { OpenAiClient } from "@effect/ai-openai"
import type * as LanguageModel from "effect/ai/LanguageModel"
import type * as Model from "effect/ai/Model"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { ThoughtLevel } from "./Acp.ts"
import * as Agent from "./Agent.ts"
import * as ClaudeAgent from "./ClaudeAgent.ts"
import * as Codex from "./Codex.ts"
import * as Copilot from "./Copilot.ts"
import * as ModelsRepo from "./ModelsRepo.ts"
import * as Xai from "./Xai.ts"

const withSubagentModel = <E, R>(
  model: Layer.Layer<
    LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName,
    E,
    R
  >,
) => Layer.merge(model, Agent.layerSubagentModel(model))

/**
 * Whether a provider supports fast mode. Only OpenAI does, through the
 * `priority` service tier.
 *
 * @since 1.0.0
 * @category Fast mode
 */
export const supportsFastMode = (provider: ModelsRepo.Provider) =>
  provider === "openai"

/**
 * The model layer for a provider and model id. `effort` is `null` for models
 * that take no reasoning effort, and `undefined` to keep the provider's
 * default effort. `fastMode` requests the `priority` service tier and is
 * ignored for providers without fast mode.
 *
 * @since 1.0.0
 * @category Layers
 */
export const make = (
  provider: ModelsRepo.Provider,
  model: string,
  effort: string | null | undefined,
  openai: OpenAiClient.Options,
  fastMode = false,
) => {
  const options =
    effort === undefined
      ? undefined
      : { reasoning: effort === null ? null : { effort: effort as any } }
  const openaiOptions = fastMode
    ? { ...options, service_tier: "priority" }
    : options
  switch (provider) {
    case "openai":
      return openai.apiKey !== undefined
        ? withSubagentModel(Codex.model(model, openaiOptions)).pipe(
            Layer.provide(OpenAiClient.layer(openai)),
          )
        : withSubagentModel(Codex.modelWebSocket(model, openaiOptions)).pipe(
            Layer.provide(Codex.layerClient),
          )
    case "xai":
      return withSubagentModel(Xai.modelWebSocket(model, options)).pipe(
        Layer.provide(Xai.layerClient),
      )
    case "claude":
      return withSubagentModel(ClaudeAgent.model(model, { effort }))
    case "copilot":
      return withSubagentModel(Copilot.model(model, options)).pipe(
        Layer.provide(Copilot.layerClient),
      )
  }
}

const isProvider = Schema.is(ModelsRepo.Provider)

/**
 * Parses a `<provider>:<model>` id as advertised over ACP.
 *
 * @since 1.0.0
 * @category Parsing
 */
export const parseAcpModelId = (modelId: string) => {
  const [provider, model, ...rest] = modelId.split(":")
  return isProvider(provider) && model !== undefined && rest.length === 0
    ? Option.some({ provider, model })
    : Option.none()
}

/**
 * An `Acp.Options.supportsFastMode` callback for `<provider>:<model>` ids.
 *
 * @since 1.0.0
 * @category ACP
 */
export const acpSupportsFastMode = (modelId: string) =>
  Option.exists(parseAcpModelId(modelId), ({ provider }) =>
    supportsFastMode(provider),
  )

/**
 * The catalog as ACP `availableModels`, with `<provider>:<id>` ids. The
 * provider is part of the name because providers share model names.
 *
 * @since 1.0.0
 * @category ACP
 */
export const acpModels = (models: ReadonlyArray<ModelsRepo.ModelInfo>) =>
  models.map((model) => ({
    modelId: `${model.provider}:${model.id}`,
    name: `${model.name} (${model.provider})`,
  }))

const rank = (level: ThoughtLevel) => ThoughtLevel.literals.indexOf(level)

// The effort a catalog model with `efforts` runs at for a session
// `thoughtLevel`: `null` for no efforts, else the nearest supported effort,
// breaking ties upward.
const resolveEffort = (
  efforts: ReadonlyArray<ThoughtLevel>,
  thoughtLevel: ThoughtLevel,
): ThoughtLevel | null => {
  const distance = (level: ThoughtLevel) =>
    Math.abs(rank(level) - rank(thoughtLevel))
  let resolved: ThoughtLevel | null = null
  for (const effort of efforts) {
    if (
      resolved === null ||
      distance(effort) < distance(resolved) ||
      (distance(effort) === distance(resolved) && rank(effort) > rank(resolved))
    ) {
      resolved = effort
    }
  }
  return resolved
}

/**
 * An `Acp.Options.makeModel` callback. Ids that do not parse as
 * `<provider>:<model>` are unknown models. A model the catalog lists without
 * efforts runs with no reasoning options, whatever the session thought level.
 * A listed model that does not support the session thought level runs at the
 * supported effort nearest to it in `ThoughtLevel` order, the higher one on a
 * tie. Unlisted models run at the session thought level. Fast mode applies
 * to OpenAI models only.
 *
 * @since 1.0.0
 * @category ACP
 */
export const makeAcp =
  (options: {
    readonly models: Effect.Effect<ReadonlyArray<ModelsRepo.ModelInfo>>
    readonly openai: OpenAiClient.Options
  }) =>
  (modelId: string, thoughtLevel: ThoughtLevel, fastMode = false) =>
    Option.map(parseAcpModelId(modelId), ({ provider, model }) =>
      Layer.unwrap(
        Effect.map(options.models, (catalog) => {
          const info = catalog.find(
            (entry) => entry.provider === provider && entry.id === model,
          )
          return make(
            provider,
            model,
            info === undefined
              ? thoughtLevel
              : resolveEffort(info.efforts, thoughtLevel),
            options.openai,
            fastMode,
          )
        }),
      ),
    )

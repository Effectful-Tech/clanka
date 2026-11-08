/**
 * @since 1.0.0
 */
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import {
  OpenAiClient as ResponsesClient,
  OpenAiLanguageModel as ResponsesLanguageModel,
} from "@effect/ai-openai"
import * as Layer from "effect/Layer"
import * as Effect from "effect/Effect"
import * as Struct from "effect/Struct"
import { API_URL, GithubCopilotAuth } from "./CopilotAuth.ts"
import { AgentModelConfig } from "./Agent.ts"
import * as Compaction from "./Compaction.ts"
import * as Model from "effect/ai/Model"
import type * as LanguageModel from "effect/ai/LanguageModel"
import { CopilotModels, CopilotModelsError } from "./CopilotModels.ts"

/**
 * @since 1.0.0
 * @category Layers
 */
export const layerClient = Layer.mergeAll(
  OpenAiClient.layer({ apiUrl: API_URL }),
  ResponsesClient.layer({ apiUrl: API_URL }),
  CopilotModels.layer,
).pipe(Layer.provide(GithubCopilotAuth.layerClient))

/**
 * @since 1.0.0
 * @category Layers
 */
export const model = (
  model: string,
  options?:
    | (OpenAiLanguageModel.Config["Service"] & typeof AgentModelConfig.Service)
    | undefined,
): Model.Model<
  "copilot",
  LanguageModel.LanguageModel,
  OpenAiClient.OpenAiClient | ResponsesClient.OpenAiClient | CopilotModels
> => {
  const config = Struct.omit(
    options ?? {},
    options?.reasoning === null
      ? ["reasoning", ...AgentModelConfig.optionKeys]
      : AgentModelConfig.optionKeys,
  )
  return Model.make(
    "copilot",
    model,
    Layer.unwrap(
      Effect.gen(function* () {
        const catalog = yield* (yield* CopilotModels).models
        const selected = catalog.find((entry) => entry.id === model)
        if (selected === undefined) {
          return yield* new CopilotModelsError({
            message: `Copilot does not advertise model "${model}" for this account. Available model IDs: ${catalog.map((entry) => entry.id).join(", ")}`,
          })
        }
        const responses = selected.endpoint === "/responses"
        return Layer.mergeAll(
          responses
            ? ResponsesLanguageModel.layer({
                model,
                config: { ...config, store: false },
              })
            : OpenAiLanguageModel.layer({ model, config }),
          AgentModelConfig.layer(
            Struct.pick(options ?? {}, AgentModelConfig.optionKeys),
          ),
          // Cap compaction summaries; Copilot honours max_output_tokens.
          Layer.succeed(Compaction.SummarizerTransform, (effect) =>
            responses
              ? ResponsesLanguageModel.withConfigOverride(effect, {
                  max_output_tokens: Compaction.summarizerMaxOutputTokens,
                })
              : OpenAiLanguageModel.withConfigOverride(effect, {
                  max_output_tokens: Compaction.summarizerMaxOutputTokens,
                }),
          ),
        )
      }).pipe(Effect.orDie),
    ),
  )
}

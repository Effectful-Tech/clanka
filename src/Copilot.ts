/**
 * @since 1.0.0
 */
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import {
  OpenAiClient as ResponsesClient,
  OpenAiLanguageModel as ResponsesLanguageModel,
} from "@effect/ai-openai"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Struct from "effect/Struct"
import { API_URL, GithubCopilotAuth } from "./CopilotAuth.ts"
import { CopilotModels } from "./CopilotModels.ts"
import { AgentModelConfig } from "./Agent.ts"
import * as Compaction from "./Compaction.ts"
import * as Model from "effect/ai/Model"
import type * as LanguageModel from "effect/ai/LanguageModel"

/**
 * Both Copilot APIs and the account catalog that says which one a model is
 * served on.
 *
 * @since 1.0.0
 * @category Layers
 */
export const layerClient = Layer.mergeAll(
  OpenAiClient.layer({ apiUrl: API_URL }),
  ResponsesClient.layer({ apiUrl: API_URL }),
  CopilotModels.layer,
).pipe(Layer.provide(GithubCopilotAuth.layerClient))

/**
 * A model by its Copilot id, on the API the account catalog advertises for
 * it. Building the layer fails for an id the catalog does not list.
 *
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
> =>
  Model.make(
    "copilot",
    model,
    Layer.unwrap(
      Effect.gen(function* () {
        const { endpoint } = yield* CopilotModels.use((repo) => repo.get(model))
        // `reasoning: null` asks for no reasoning options.
        const config = Struct.omit(
          options ?? {},
          options?.reasoning === null
            ? ["reasoning", ...AgentModelConfig.optionKeys]
            : AgentModelConfig.optionKeys,
        )
        const responses = endpoint === "/responses"
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

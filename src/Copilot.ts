/**
 * @since 1.0.0
 */
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import {
  OpenAiClient as ResponsesClient,
  OpenAiLanguageModel as ResponsesLanguageModel,
} from "@effect/ai-openai"
import * as Layer from "effect/Layer"
import * as Struct from "effect/Struct"
import { API_URL, GithubCopilotAuth } from "./CopilotAuth.ts"
import { AgentModelConfig } from "./Agent.ts"
import * as Compaction from "./Compaction.ts"
import * as Model from "effect/ai/Model"
import type * as LanguageModel from "effect/ai/LanguageModel"

/**
 * @since 1.0.0
 * @category Layers
 */
export const layerClient = Layer.mergeAll(
  OpenAiClient.layer({ apiUrl: API_URL }),
  ResponsesClient.layer({ apiUrl: API_URL }),
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
  OpenAiClient.OpenAiClient | ResponsesClient.OpenAiClient
> => {
  // Recent GPT models, Grok and MAI Code are Responses-only on Copilot.
  // GPT-5 mini and older GPT models still use Chat Completions.
  const gpt = /^gpt-(\d+)/.exec(model)
  const responses =
    (gpt !== null && Number(gpt[1]) >= 5 && !model.startsWith("gpt-5-mini")) ||
    model.startsWith("grok-") ||
    model.startsWith("mai-code-")
  const config = Struct.omit(
    options ?? {},
    options?.reasoning === null
      ? ["reasoning", ...AgentModelConfig.optionKeys]
      : AgentModelConfig.optionKeys,
  )
  return Model.make(
    "copilot",
    model,
    Layer.mergeAll(
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
    ),
  )
}

/**
 * @since 1.0.0
 */
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import * as Layer from "effect/Layer"
import * as Struct from "effect/Struct"
import { API_URL, GithubCopilotAuth } from "./CopilotAuth.ts"
import { AgentModelConfig } from "./Agent.ts"
import * as Model from "effect/unstable/ai/Model"
import type * as LanguageModel from "effect/unstable/ai/LanguageModel"

/**
 * @since 1.0.0
 * @category Layers
 */
export const layerClient = OpenAiClient.layer({
  apiUrl: API_URL,
}).pipe(Layer.provide(GithubCopilotAuth.layerClient))

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
  "openai",
  LanguageModel.LanguageModel,
  OpenAiClient.OpenAiClient
> =>
  Model.make(
    "openai",
    model,
    Layer.merge(
      OpenAiLanguageModel.layer({
        model,
        config: Struct.omit(options ?? {}, [
          "supportsNoTools",
          "supportsAssistantPrefill",
        ]),
      }),
      AgentModelConfig.layer({
        systemPromptTransform: options?.systemPromptTransform,
      }),
    ),
  )

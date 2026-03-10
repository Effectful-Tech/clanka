/**
 * @since 1.0.0
 */
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import { Layer } from "effect"
import { API_URL, GithubCopilotAuth } from "./CopilotAuth.ts"
import { AgentModelConfig } from "./Agent.ts"
import { Model } from "effect/unstable/ai"
import type { HttpClient } from "effect/unstable/http/HttpClient"
import type { KeyValueStore } from "effect/unstable/persistence/KeyValueStore"
import type { LanguageModel } from "effect/unstable/ai/LanguageModel"

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
): Model.Model<"openai", LanguageModel, HttpClient | KeyValueStore> =>
  Model.make(
    "openai",
    model,
    Layer.merge(
      OpenAiLanguageModel.layer({
        model,
        config: options,
      }),
      AgentModelConfig.layer({
        supportsAssistantPrefill: options?.supportsAssistantPrefill ?? false,
        supportsNoTools: options?.supportsNoTools ?? false,
      }),
    ).pipe(Layer.provide(layerClient)),
  )

/**
 * @since 1.0.0
 */
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { Layer, Record, Struct } from "effect"
import { CodexAuth } from "./CodexAuth.ts"
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
  apiUrl: "https://chatgpt.com/backend-api/codex",
}).pipe(Layer.provide(CodexAuth.layerClient))

/**
 * @since 1.0.0
 * @category Layers
 */
export const model = (
  model: (string & {}) | OpenAiLanguageModel.Model,
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
        config: {
          ...Struct.omit(options ?? {}, [
            "reasoning",
            "supportsNoTools",
            "supportsAssistantPrefill",
          ]),
          store: false,
          reasoning: {
            effort: options?.reasoning?.effort ?? "medium",
            summary: "auto",
          },
        },
      }),
      AgentModelConfig.layer({
        systemPromptTransform: (system, effect) =>
          OpenAiLanguageModel.withConfigOverride(effect, {
            instructions: system,
          }),
        supportsAssistantPrefill: options?.supportsAssistantPrefill ?? true,
        supportsNoTools: options?.supportsNoTools ?? true,
      }),
    ).pipe(Layer.provide(layerClient)),
  )

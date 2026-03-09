/**
 * @since 1.0.0
 */
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { Layer } from "effect"
import { CodexAuth } from "./CodexAuth.ts"
import { AgentModelConfig } from "./Agent.ts"

/**
 * @since 1.0.0
 * @category Layers
 */
export const layerModelConfig = AgentModelConfig.layer({
  systemPromptTransform: (system, effect) =>
    OpenAiLanguageModel.withConfigOverride(effect, {
      store: false,
      instructions: system,
    }),
  supportsAssistantPrefill: true,
  supportsNoTools: true,
})

/**
 * @since 1.0.0
 * @category Layers
 */
export const layer = OpenAiClient.layer({
  apiUrl: "https://chatgpt.com/backend-api/codex",
}).pipe(Layer.merge(layerModelConfig), Layer.provide(CodexAuth.layerClient))

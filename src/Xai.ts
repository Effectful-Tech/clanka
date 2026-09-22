/**
 * @since 1.0.0
 */
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import * as Layer from "effect/Layer"
import * as Struct from "effect/Struct"
import { XaiAuth } from "./XaiAuth.ts"
import { AgentModelConfig } from "./Agent.ts"
import * as Compaction from "./Compaction.ts"
import * as Model from "effect/ai/Model"
import type * as LanguageModel from "effect/ai/LanguageModel"
import type * as Socket from "effect/socket/Socket"
import type * as ResponseIdTracker from "effect/ai/ResponseIdTracker"

/**
 * @since 1.0.0
 * @category Layers
 */
export const layerClient = OpenAiClient.layer({
  apiUrl: "https://api.x.ai/v1",
}).pipe(Layer.provide(XaiAuth.layerClient))

/**
 * @since 1.0.0
 * @category Layers
 */
export const model = (
  model: string,
  options?:
    | (OpenAiLanguageModel.Config["Service"] & typeof AgentModelConfig.Service)
    | undefined,
): Model.Model<"xai", LanguageModel.LanguageModel, OpenAiClient.OpenAiClient> =>
  Model.make(
    "xai",
    model,
    Layer.mergeAll(
      OpenAiLanguageModel.layer({
        model,
        config: {
          ...Struct.omit(options ?? {}, [
            "systemPromptTransform",
            "supportsImages",
          ]),
          store: options?.store ?? false,
          reasoning: { effort: "high", ...options?.reasoning },
        },
      }),
      AgentModelConfig.layer({
        systemPromptTransform: options?.systemPromptTransform,
        supportsImages: options?.supportsImages,
      }),
      // Cap compaction summaries; xAI honours max_output_tokens.
      Layer.succeed(Compaction.SummarizerTransform, (effect) =>
        OpenAiLanguageModel.withConfigOverride(effect, {
          max_output_tokens: Compaction.summarizerMaxOutputTokens,
        }),
      ),
    ),
  )

/**
 * @since 1.0.0
 * @category Layers
 */
export const modelWebSocket = (
  model: string,
  options?:
    | (OpenAiLanguageModel.Config["Service"] & typeof AgentModelConfig.Service)
    | undefined,
): Model.Model<
  "xai",
  | LanguageModel.LanguageModel
  | OpenAiClient.OpenAiSocket
  | ResponseIdTracker.ResponseIdTracker,
  OpenAiClient.OpenAiClient | Socket.WebSocketConstructor
> =>
  Model.make(
    "xai",
    model,
    Layer.mergeAll(
      OpenAiLanguageModel.layer({
        model,
        config: {
          ...Struct.omit(options ?? {}, [
            "systemPromptTransform",
            "supportsImages",
          ]),
          // xAI needs stored responses to resolve previous_response_id.
          store: true,
          useItemReferences: false,
          reasoning: { effort: "high", ...options?.reasoning },
        },
      }),
      AgentModelConfig.layer({
        systemPromptTransform: options?.systemPromptTransform,
        supportsImages: options?.supportsImages,
      }),
      // Cap compaction summaries; xAI honours max_output_tokens.
      Layer.succeed(Compaction.SummarizerTransform, (effect) =>
        OpenAiLanguageModel.withConfigOverride(effect, {
          max_output_tokens: Compaction.summarizerMaxOutputTokens,
        }),
      ),
      Layer.fresh(OpenAiClient.layerWebSocketMode),
    ),
  )

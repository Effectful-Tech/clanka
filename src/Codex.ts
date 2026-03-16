/**
 * @since 1.0.0
 */
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import * as Layer from "effect/Layer"
import * as Struct from "effect/Struct"
import { CodexAuth } from "./CodexAuth.ts"
import { AgentModelConfig } from "./Agent.ts"
import * as Model from "effect/unstable/ai/Model"
import type * as LanguageModel from "effect/unstable/ai/LanguageModel"
import type * as Socket from "effect/unstable/socket/Socket"
import type * as ResponseIdTracker from "effect/unstable/ai/ResponseIdTracker"

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
): Model.Model<
  "openai",
  LanguageModel.LanguageModel,
  OpenAiClient.OpenAiClient
> => Model.make("openai", model, layerModel(model, options))

/**
 * @since 1.0.0
 * @category Layers
 */
export const modelWebSocket = (
  model: (string & {}) | OpenAiLanguageModel.Model,
  options?:
    | (OpenAiLanguageModel.Config["Service"] & typeof AgentModelConfig.Service)
    | undefined,
): Model.Model<
  "openai",
  | LanguageModel.LanguageModel
  | OpenAiClient.OpenAiSocket
  | ResponseIdTracker.ResponseIdTracker,
  OpenAiClient.OpenAiClient | Socket.WebSocketConstructor
> =>
  Model.make(
    "openai",
    model,
    layerModel(model, options).pipe(
      Layer.merge(OpenAiClient.layerWebSocketMode),
    ),
  )

const layerModel = (
  model: (string & {}) | OpenAiLanguageModel.Model,
  options?:
    | (OpenAiLanguageModel.Config["Service"] & typeof AgentModelConfig.Service)
    | undefined,
) =>
  OpenAiLanguageModel.layer({
    model,
    config: {
      ...Struct.omit(options ?? {}, ["reasoning"]),
      store: false,
      reasoning: {
        effort: options?.reasoning?.effort ?? "medium",
        summary: "auto",
      },
    },
  }).pipe(
    Layer.merge(
      AgentModelConfig.layer({
        systemPromptTransform: (system, effect) =>
          OpenAiLanguageModel.withConfigOverride(effect, {
            instructions: system,
          }),
      }),
    ),
  )

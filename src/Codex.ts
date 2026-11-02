/**
 * @since 1.0.0
 */
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Struct from "effect/Struct"
import { CodexAuth } from "./CodexAuth.ts"
import { AgentModelConfig } from "./Agent.ts"
import * as Model from "effect/ai/Model"
import type * as LanguageModel from "effect/ai/LanguageModel"
import type * as Socket from "effect/socket/Socket"
import type * as ResponseIdTracker from "effect/ai/ResponseIdTracker"

/**
 * @since 1.0.0
 * @category Layers
 */
export const layerClient = OpenAiClient.layer({
  apiUrl: "https://chatgpt.com/backend-api/codex",
}).pipe(Layer.provide(CodexAuth.layerClient))

/**
 * Options for a model. `reasoning: null` sends no reasoning options, for
 * models that accept none; omitting `reasoning` keeps the default effort.
 *
 * @since 1.0.0
 * @category Models
 */
export type ModelOptions = Omit<
  OpenAiLanguageModel.Config["Service"],
  "reasoning"
> & {
  readonly reasoning?:
    OpenAiLanguageModel.Config["Service"]["reasoning"] | null | undefined
} & typeof AgentModelConfig.Service

/**
 * @since 1.0.0
 * @category Layers
 */
export const model = (
  model: (string & {}) | OpenAiLanguageModel.Model,
  options?: ModelOptions | undefined,
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
  options?: ModelOptions | undefined,
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
      Layer.merge(Layer.fresh(OpenAiClient.layerWebSocketMode)),
    ),
  )

const layerModel = (
  model: (string & {}) | OpenAiLanguageModel.Model,
  options?: ModelOptions | undefined,
) =>
  // One prompt cache key per model layer, so the requests of a session, and
  // of the sub-agents sharing its system prompt, are routed to the same
  // cache. A key in `options` wins.
  Layer.unwrap(
    Effect.sync(() =>
      OpenAiLanguageModel.layer({
        model,
        config: {
          ...Struct.omit(options ?? {}, [
            "reasoning",
            "systemPromptTransform",
            "supportsImages",
            "cutStreamOnSteering",
          ]),
          prompt_cache_key: options?.prompt_cache_key ?? crypto.randomUUID(),
          store: false,
          reasoning:
            options?.reasoning === null
              ? undefined
              : {
                  effort: "medium",
                  summary: "auto",
                  ...(options?.reasoning as any),
                },
        },
      }),
    ),
  ).pipe(
    Layer.merge(
      AgentModelConfig.layer({
        systemPromptTransform: (system, effect) =>
          OpenAiLanguageModel.withConfigOverride(effect, {
            instructions: system,
          }),
        supportsImages: options?.supportsImages,
        cutStreamOnSteering: options?.cutStreamOnSteering,
      }),
      // No Compaction.SummarizerTransform: Codex rejects max_output_tokens,
      // so compaction summaries have no configured output-token cap.
    ),
  )

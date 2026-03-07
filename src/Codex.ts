import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { Layer } from "effect"
import { CODEX_API_BASE, CodexAuth } from "./CodexAuth.ts"

const DEFAULT_MODEL = "gpt-5.3-codex"

const clientLayer = OpenAiClient.layer({ apiUrl: CODEX_API_BASE }).pipe(
  Layer.provide(
    CodexAuth.layerClient.pipe(Layer.provideMerge(CodexAuth.layer)),
  ),
)

export const model = (modelId: string) =>
  OpenAiLanguageModel.layer({ model: modelId }).pipe(
    Layer.provideMerge(clientLayer),
  )

export const layer = model(DEFAULT_MODEL)

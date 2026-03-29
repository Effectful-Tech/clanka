import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Model from "effect/unstable/ai/Model"
import * as Agent from "./Agent.ts"
import * as AgentExecutor from "./AgentExecutor.ts"

const capabilities = new AgentExecutor.Capabilities({
  toolsDts: "",
  agentsMd: Option.none(),
  supportsSearch: false,
})

const makeExecutor = (
  execute: AgentExecutor.AgentExecutor["Service"]["execute"] = () =>
    Stream.empty,
) =>
  AgentExecutor.AgentExecutor.of({
    capabilities: Effect.succeed(capabilities),
    execute,
    executeUnsafe: () => Effect.die("executeUnsafe not implemented"),
  })

const runAgent = (options: {
  readonly conversationMode?: boolean | undefined
  readonly executor?: AgentExecutor.AgentExecutor["Service"] | undefined
  readonly streamText: Parameters<typeof LanguageModel.make>[0]["streamText"]
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const languageModel = yield* LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: options.streamText,
      })
      const modelLayer = Layer.mergeAll(
        Layer.succeed(LanguageModel.LanguageModel, languageModel),
        Layer.succeed(Model.ProviderName, "test-provider"),
        Layer.succeed(Model.ModelName, "test-model"),
      )
      const agent = yield* Agent.make.pipe(
        Effect.provideService(
          AgentExecutor.AgentExecutor,
          options.executor ?? makeExecutor(),
        ),
      )

      return yield* agent.send({ prompt: "hello" }).pipe(
        Effect.flatMap((stream) =>
          stream.pipe(
            Stream.runDrain,
            Effect.as(""),
            Effect.catchTag("AgentFinished", (finished) =>
              Effect.succeed(finished.summary),
            ),
          ),
        ),
        Effect.provide(
          Layer.mergeAll(
            modelLayer,
            Agent.ConversationMode.layer(options.conversationMode ?? false),
            Agent.layerSubagentModel(modelLayer),
          ),
        ),
      )
    }),
  )

describe("Agent", () => {
  it.effect("ConversationMode defaults to false", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* Agent.ConversationMode, false)
    }),
  )

  it.effect(
    "finishes with the assistant response when conversation mode is enabled",
    () =>
      runAgent({
        conversationMode: true,
        streamText: () =>
          Stream.fromIterable([
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "Hello from the assistant" },
            { type: "text-end", id: "1" },
          ]),
      }).pipe(
        Effect.map((summary) => {
          assert.strictEqual(summary, "Hello from the assistant")
        }),
      ),
  )

  it.effect(
    "still finishes when taskComplete is called in conversation mode",
    () =>
      runAgent({
        conversationMode: true,
        executor: makeExecutor(({ onTaskComplete }) =>
          Stream.fromEffect(
            onTaskComplete("done from taskComplete").pipe(Effect.as("")),
          ),
        ),
        streamText: () =>
          Stream.fromIterable([
            {
              type: "tool-call",
              id: "call-1",
              name: "execute",
              params: {
                script: 'await taskComplete("done from taskComplete")',
              },
            },
          ]),
      }).pipe(
        Effect.map((summary) => {
          assert.strictEqual(summary, "done from taskComplete")
        }),
      ),
  )
})

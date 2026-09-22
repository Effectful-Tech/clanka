import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as AiError from "effect/ai/AiError"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import type * as Prompt from "effect/ai/Prompt"
import type * as Response from "effect/ai/Response"
import * as Agent from "./Agent.ts"
import * as AgentExecutor from "./AgentExecutor.ts"
import { tinyPng } from "./fixtures/TestImages.ts"

const capabilities = new AgentExecutor.Capabilities({
  toolsDts: "",
  agentsMd: Option.none(),
  supportsSearch: false,
  skills: [],
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

interface RecordedCall {
  readonly prompt: Prompt.Prompt
}

const runAgent = (options: {
  readonly prompt: Prompt.RawInput
  readonly executor?: AgentExecutor.AgentExecutor["Service"] | undefined
  readonly modelConfig?: typeof Agent.AgentModelConfig.Service | undefined
  readonly respond: (
    call: RecordedCall,
    index: number,
  ) => Stream.Stream<Response.StreamPartEncoded, AiError.AiError>
}) =>
  Effect.gen(function* () {
    const calls: Array<RecordedCall> = []
    const languageModel = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: (providerOptions) => {
        const call = { prompt: providerOptions.prompt }
        const index = calls.push(call) - 1
        return options.respond(call, index)
      },
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
    const exit = yield* agent.send({ prompt: options.prompt }).pipe(
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
          Agent.ConversationMode.layer(true),
          Agent.layerSubagentModel(modelLayer),
          Agent.AgentModelConfig.layer(options.modelConfig ?? {}),
          Layer.succeed(Agent.TurnTimeout, Duration.minutes(5)),
        ),
      ),
      Effect.exit,
    )
    return { exit, calls, history: agent.history.current }
  }).pipe(Effect.scoped)

const text = (content: string): Array<Response.StreamPartEncoded> => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: content },
  { type: "text-end", id: "t" },
]

const toolCall = (id: string, script: string): Response.StreamPartEncoded => ({
  type: "tool-call",
  id,
  name: "execute",
  params: { script },
})

/** A user turn with a caption and a screenshot, as ACP ingest would build. */
const imagePrompt: Prompt.RawInput = [
  {
    role: "user",
    content: [
      { type: "text", text: "what is in this screenshot?" },
      {
        type: "file",
        mediaType: "image/png",
        fileName: "shot.png",
        data: tinyPng,
      },
    ],
  },
]

const fileParts = (prompt: Prompt.Prompt): Array<Prompt.FilePart> =>
  prompt.content.flatMap((message) =>
    message.role === "user"
      ? message.content.filter((part) => part.type === "file")
      : [],
  )

const userText = (prompt: Prompt.Prompt): string =>
  prompt.content
    .flatMap((message) =>
      message.role === "user"
        ? message.content.flatMap((part) =>
            part.type === "text" ? [part.text] : [],
          )
        : [],
    )
    .join("\n")

const omittedNote = /\[image: shot\.png omitted\]/

/** Mirrors the OpenAI rejection for image input on a text-only model. */
const unsupportedImageError = AiError.make({
  module: "OpenAiLanguageModel",
  method: "streamText",
  reason: new AiError.InvalidRequestError({
    description:
      "Invalid content type. image_url is only supported by certain models. (POST https://api.openai.com/v1/responses) [code: invalid_value]",
  }),
})

const unrelatedError = AiError.make({
  module: "OpenAiLanguageModel",
  method: "streamText",
  reason: new AiError.InvalidRequestError({
    description:
      "Unsupported parameter: 'temperature' is not supported with this model. (POST https://api.openai.com/v1/responses)",
  }),
})

describe("Agent images", () => {
  it.effect(
    "strips images and leaves an omitted note for a model known not to take images",
    () =>
      Effect.gen(function* () {
        const { exit, calls } = yield* runAgent({
          prompt: imagePrompt,
          modelConfig: { supportsImages: false },
          respond: () => Stream.fromIterable(text("I cannot see images.")),
        })
        assert.isTrue(Exit.isSuccess(exit))
        assert.strictEqual(calls.length, 1)
        assert.strictEqual(fileParts(calls[0]!.prompt).length, 0)
        const prompt = userText(calls[0]!.prompt)
        assert.include(prompt, "what is in this screenshot?")
        assert.match(prompt, omittedNote)
      }),
  )

  it.effect(
    "retries without images and discards attachments from the failed attempt",
    () =>
      Effect.gen(function* () {
        const attached = yield* Deferred.make<void>()
        let executions = 0
        const executor = makeExecutor(({ onImage }) =>
          Stream.fromEffect(
            Effect.gen(function* () {
              executions++
              yield* onImage({
                data: tinyPng,
                mediaType: "image/png",
                fileName: executions === 1 ? "discarded.png" : "shot.png",
              })
              yield* Deferred.succeed(attached, undefined)
              return "Image attached"
            }),
          ),
        )
        const { exit, calls, history } = yield* runAgent({
          prompt: imagePrompt,
          executor,
          respond: (_, index) =>
            index === 0
              ? Stream.make(
                  toolCall("discarded", 'await readFile({ path: "shot.png" })'),
                ).pipe(
                  // Advance past the tool-call chunk so its handler starts.
                  Stream.concat(
                    Stream.make({ type: "text-start", id: "failed" } as const),
                  ),
                  Stream.concat(
                    Stream.fromEffect(
                      Deferred.await(attached).pipe(
                        Effect.andThen(Effect.fail(unsupportedImageError)),
                      ),
                    ),
                  ),
                )
              : index === 1
                ? Stream.make(
                    toolCall("retried", 'await readFile({ path: "shot.png" })'),
                  )
                : Stream.fromIterable(text("Text only, but I tried.")),
        })
        assert.isTrue(Exit.isSuccess(exit))
        assert.strictEqual(calls.length, 3)
        assert.strictEqual(executions, 2)
        assert.deepStrictEqual(
          fileParts(history).map((part) => part.fileName),
          ["shot.png", "shot.png"],
        )
        assert.strictEqual(fileParts(calls[0]!.prompt).length, 1)
        assert.strictEqual(fileParts(calls[1]!.prompt).length, 0)
        const retried = userText(calls[1]!.prompt)
        assert.include(retried, "what is in this screenshot?")
        assert.match(retried, omittedNote)
      }),
  )

  it.effect("does not retry when the provider rejects it a second time", () =>
    Effect.gen(function* () {
      const { exit, calls } = yield* runAgent({
        prompt: imagePrompt,
        respond: () => Stream.fail(unsupportedImageError),
      })
      assert.isTrue(Exit.isFailure(exit))
      assert.strictEqual(calls.length, 2)
    }),
  )

  it.effect(
    "does not treat other invalid-request errors as image rejections",
    () =>
      Effect.gen(function* () {
        const { exit, calls } = yield* runAgent({
          prompt: imagePrompt,
          respond: () => Stream.fail(unrelatedError),
        })
        assert.isTrue(Exit.isFailure(exit))
        assert.strictEqual(calls.length, 1)
      }),
  )

  it.effect("does not copy image bytes into a delegate prompt", () =>
    Effect.gen(function* () {
      const executor = makeExecutor(({ onSubagent }) =>
        Stream.fromEffect(onSubagent("child task: describe the layout")),
      )
      const { exit, calls } = yield* runAgent({
        prompt: imagePrompt,
        executor,
        respond: (call, index) => {
          if (index === 0) {
            return Stream.make(
              toolCall("call-1", 'await delegate("describe the layout")'),
            )
          }
          const isChild = userText(call.prompt).includes("child task")
          return Stream.fromIterable(
            text(isChild ? "child done" : "parent done"),
          )
        },
      })
      assert.isTrue(Exit.isSuccess(exit))
      const child = calls.find((call) =>
        userText(call.prompt).includes("child task"),
      )
      assert.isDefined(child, "the delegate call reached the model")
      assert.strictEqual(fileParts(child!.prompt).length, 0)
      // The parent still has its image.
      assert.strictEqual(fileParts(calls[0]!.prompt).length, 1)
    }),
  )
})

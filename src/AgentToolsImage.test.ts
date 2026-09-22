import * as Photon from "@silvia-odwyer/photon-node"
import { assert, describe, it } from "@effect/vitest"
import { vi } from "vitest"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import type * as Prompt from "effect/ai/Prompt"
import type * as Response from "effect/ai/Response"
import * as Agent from "./Agent.ts"
import * as AgentExecutor from "./AgentExecutor.ts"
import type * as AgentOutput from "./AgentOutput.ts"
import {
  bytesOf,
  dimensions,
  encodePng,
  equalBytes,
  tinyPng,
} from "./fixtures/TestImages.ts"

const svgText =
  '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'

/**
 * A temp project directory holding the image fixtures, with a real local
 * executor rooted in it.
 */
const withProject = <A, E, R>(f: (project: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const project = yield* fs.makeTempDirectoryScoped()
    yield* fs.writeFile(path.join(project, "shot.png"), tinyPng)
    yield* fs.writeFile(
      path.join(project, "wide.png"),
      encodePng({ width: 2500, height: 100 }),
    )
    yield* fs.writeFileString(path.join(project, "logo.svg"), svgText)
    yield* fs.writeFile(
      path.join(project, "broken.png"),
      new TextEncoder().encode("this is not a png".repeat(20)),
    )
    return yield* f(project).pipe(
      Effect.provide(
        AgentExecutor.layerLocal({ directory: project }).pipe(
          Layer.provide(NodeHttpClient.layerUndici),
        ),
      ),
    )
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const readFile = (params: {
  readonly path: string
  readonly startLine?: number
  readonly endLine?: number
}) =>
  Effect.gen(function* () {
    const executor = yield* AgentExecutor.AgentExecutor
    return yield* executor.executeUnsafe({ tool: "readFile", params })
  })

describe("readFile images", () => {
  it.effect("rejects startLine / endLine on an image", () =>
    withProject(() =>
      Effect.gen(function* () {
        const withStart = yield* Effect.exit(
          readFile({ path: "shot.png", startLine: 1 }),
        )
        assert.isTrue(Exit.isFailure(withStart))
        const withEnd = yield* Effect.exit(
          readFile({ path: "shot.png", endLine: 5 }),
        )
        assert.isTrue(Exit.isFailure(withEnd))
      }),
    ),
  )

  it.effect(
    "rejects undecodable and over-ceiling images without decoding them",
    () =>
      withProject((project) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          // Sparse file one byte over the shared 20 MiB input ceiling.
          const huge = path.join(project, "huge.png")
          yield* fs.writeFile(huge, tinyPng)
          yield* fs.truncate(huge, 20 * 1024 * 1024 + 1)

          const decoder = vi.spyOn(Photon.PhotonImage, "new_from_byteslice")
          try {
            const broken = yield* Effect.exit(readFile({ path: "broken.png" }))
            assert.isTrue(Exit.isFailure(broken))
            const oversized = yield* Effect.exit(readFile({ path: "huge.png" }))
            assert.isTrue(Exit.isFailure(oversized))
            assert.strictEqual(
              decoder.mock.calls.length,
              0,
              "neither garbage nor an over-ceiling file may reach the decoder",
            )
          } finally {
            decoder.mockRestore()
          }
        }),
      ),
  )
})

// =============================================================================
// Injection into the next model turn, through the real Agent loop
// =============================================================================

interface RecordedCall {
  readonly prompt: Prompt.Prompt
}

const runAgent = (options: {
  readonly respond: (
    call: RecordedCall,
    index: number,
  ) => Stream.Stream<Response.StreamPartEncoded>
}) =>
  Effect.gen(function* () {
    const calls: Array<RecordedCall> = []
    const outputs: Array<AgentOutput.Output> = []
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
    const agent = yield* Agent.make
    const exit = yield* agent.send({ prompt: "read the screenshot" }).pipe(
      Effect.flatMap((stream) =>
        stream.pipe(
          Stream.runForEach((output) =>
            Effect.sync(() => {
              outputs.push(output)
            }),
          ),
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
          Layer.succeed(Agent.TurnTimeout, Duration.minutes(5)),
        ),
      ),
      Effect.exit,
    )
    return { exit, calls, outputs }
  }).pipe(Effect.scoped)

const toolCall = (id: string, script: string): Response.StreamPartEncoded => ({
  type: "tool-call",
  id,
  name: "execute",
  params: { script },
})

const text = (content: string): Array<Response.StreamPartEncoded> => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: content },
  { type: "text-end", id: "t" },
]

const toolResultText = (message: Prompt.Message): string | undefined => {
  if (message.role !== "tool") return undefined
  const part = message.content.find((p) => p.type === "tool-result")
  return part && typeof part.result === "string" ? part.result : undefined
}

const fileParts = (message: Prompt.Message): Array<Prompt.FilePart> =>
  message.role === "user"
    ? message.content.filter((part) => part.type === "file")
    : []

describe("readFile image injection", () => {
  it.effect("injects an image as a file part after the execute result", () =>
    withProject(() =>
      Effect.gen(function* () {
        const { exit, calls, outputs } = yield* runAgent({
          respond: (_, index) =>
            index === 0
              ? Stream.make(
                  toolCall(
                    "call-1",
                    'console.log(await readFile({ path: "shot.png" }))',
                  ),
                )
              : Stream.fromIterable(text("It is a red rectangle.")),
        })
        assert.isTrue(Exit.isSuccess(exit))
        assert.strictEqual(calls.length, 2)

        const messages = calls[1]!.prompt.content
        const resultIndex = messages.findIndex((m) =>
          toolResultText(m)?.includes("Image attached: shot.png"),
        )
        assert.notStrictEqual(resultIndex, -1, "script saw the marker")

        const image = messages
          .slice(resultIndex + 1)
          .flatMap(fileParts)
          .find((part) => part.mediaType === "image/png")
        assert.isDefined(image, "a file part follows the tool result")
        assert.strictEqual(
          calls[1]!.prompt.content.flatMap(fileParts).length,
          1,
        )
        assert.strictEqual(image!.fileName, "shot.png")
        assert.isTrue(equalBytes(bytesOf(image!.data), tinyPng))

        // The first model call had no image: injection happens after the
        // script runs, not before.
        assert.strictEqual(
          calls[0]!.prompt.content.flatMap(fileParts).length,
          0,
        )

        // The script output shown to the client is the marker, not bytes.
        const scriptOutput = outputs.find(
          (o): o is AgentOutput.ScriptOutput => o._tag === "ScriptOutput",
        )
        assert.isDefined(scriptOutput)
        assert.include(scriptOutput!.output, "Image attached: shot.png")
        assert.isBelow(scriptOutput!.output.length, 200)
      }),
    ),
  )

  it.effect("applies the image limits to readFile images", () =>
    withProject(() =>
      Effect.gen(function* () {
        const { exit, calls } = yield* runAgent({
          respond: (_, index) =>
            index === 0
              ? Stream.make(
                  toolCall(
                    "call-1",
                    'console.log(await readFile({ path: "wide.png" }))',
                  ),
                )
              : Stream.fromIterable(text("done")),
        })
        assert.isTrue(Exit.isSuccess(exit))
        const images = calls[1]!.prompt.content.flatMap(fileParts)
        assert.strictEqual(images.length, 1)
        const size = dimensions(bytesOf(images[0]!.data))
        assert.isAtMost(size.width, 2000)
        assert.isAtMost(size.height, 2000)
      }),
    ),
  )

  it.effect("reads SVG as text without injecting an image", () =>
    withProject(() =>
      Effect.gen(function* () {
        const { calls } = yield* runAgent({
          respond: (_, index) =>
            index === 0
              ? Stream.make(
                  toolCall(
                    "call-1",
                    'console.log(await readFile({ path: "logo.svg" }))',
                  ),
                )
              : Stream.fromIterable(text("done")),
        })
        assert.strictEqual(calls.length, 2)
        assert.strictEqual(
          calls[1]!.prompt.content.flatMap(fileParts).length,
          0,
        )
        const result = calls[1]!.prompt.content
          .map(toolResultText)
          .find((r) => r !== undefined)
        assert.include(result, "<svg")
      }),
    ),
  )
})

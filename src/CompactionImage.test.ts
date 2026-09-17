import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Compaction from "./Compaction.ts"
import { tinyPng } from "./fixtures/TestImages.ts"

const base64 = Encoding.encodeBase64(tinyPng)

const user = (text: string) =>
  Prompt.makeMessage("user", {
    content: [Prompt.makePart("text", { text })],
  })

const userWithImage = (text: string, fileName: string, data: Uint8Array) =>
  Prompt.makeMessage("user", {
    content: [
      Prompt.makePart("text", { text }),
      Prompt.makePart("file", { mediaType: "image/png", fileName, data }),
    ],
  })

const assistantText = (text: string) =>
  Prompt.makeMessage("assistant", {
    content: [Prompt.makePart("text", { text })],
  })

const system = Prompt.makeMessage("system", { content: "You are a test." })

const promptJson = (prompt: Prompt.Prompt): string =>
  JSON.stringify(prompt.content)

const hasFileParts = (prompt: Prompt.Prompt): boolean =>
  prompt.content.some(
    (message) =>
      message.role === "user" &&
      message.content.some((part) => part.type === "file"),
  )

describe("Compaction.compact with images", () => {
  it.effect("never sends image parts to the summarizer", () =>
    Effect.gen(function* () {
      const summarizerPrompts: Array<Prompt.Prompt> = []
      const languageModel = yield* LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: (options) => {
          summarizerPrompts.push(options.prompt)
          return Stream.fromIterable([
            { type: "text-start", id: "s" },
            { type: "text-delta", id: "s", delta: "SUMMARY" },
            { type: "text-end", id: "s" },
          ])
        },
      })
      // Old image turn to summarize, then a fat text tail so the cut lands
      // after the image.
      const filler = "tail ".repeat(3_000)
      const history = Prompt.fromMessages([
        system,
        userWithImage("look at this", "shot.png", tinyPng),
        Prompt.makeMessage("user", {
          content: [
            Prompt.makePart("file", { mediaType: "image/png", data: base64 }),
          ],
        }),
        assistantText("It is a red rectangle."),
        user("now the next thing"),
        assistantText(filler),
        user("and again"),
        assistantText(filler),
      ])

      const result = yield* Compaction.compact({
        prompt: history,
        reason: "threshold",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(LanguageModel.LanguageModel, languageModel),
            Compaction.CompactionConfig.layer({ keepRecentTokens: 2_000 }),
          ),
        ),
      )
      const compacted = Option.getOrThrow(result)
      assert.strictEqual(summarizerPrompts.length, 1)
      const sent = promptJson(summarizerPrompts[0]!)
      assert.notInclude(sent, base64)
      assert.isFalse(hasFileParts(summarizerPrompts[0]!))
      assert.include(sent, "[image: shot.png omitted]")
      assert.include(sent, "[image: unnamed omitted]")
      assert.include(sent, "look at this")

      // The rewritten prompt carries the summary and no stale image bytes
      // from the summarized side.
      const rewritten = promptJson(compacted.prompt)
      assert.include(rewritten, "SUMMARY")
      assert.notInclude(rewritten, base64)
    }),
  )

  it.effect("keeps image parts in the kept tail", () =>
    Effect.gen(function* () {
      const languageModel = yield* LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: () =>
          Stream.fromIterable([
            { type: "text-start", id: "s" },
            { type: "text-delta", id: "s", delta: "SUMMARY" },
            { type: "text-end", id: "s" },
          ]),
      })
      const filler = "old ".repeat(3_000)
      const history = Prompt.fromMessages([
        system,
        user("start"),
        assistantText(filler),
        user("more"),
        assistantText(filler),
        // Recent image turn that must survive compaction verbatim.
        userWithImage("latest screenshot", "latest.png", tinyPng),
      ])
      const result = yield* Compaction.compact({
        prompt: history,
        reason: "threshold",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(LanguageModel.LanguageModel, languageModel),
            Compaction.CompactionConfig.layer({ keepRecentTokens: 500 }),
          ),
        ),
      )
      const compacted = Option.getOrThrow(result)
      assert.isTrue(hasFileParts(compacted.prompt))
      assert.include(promptJson(compacted.prompt), "latest screenshot")
    }),
  )
})

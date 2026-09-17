/**
 * Contract for image parts under compaction (src/Compaction.ts).
 *
 * - Image parts stay in the live Prompt until compaction.
 * - The summarizer never receives image bytes: on the summarized side every
 *   image is rendered as `[image: <name> omitted]`.
 * - `estimateTokens` already counts base64, so images trip the threshold.
 */
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Compaction from "./Compaction.ts"
import { encodePng, noisePixel, tinyPng } from "./fixtures/TestImages.ts"

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

const assistantCall = (id: string, script: string) =>
  Prompt.makeMessage("assistant", {
    content: [
      Prompt.makePart("tool-call", {
        id,
        name: "execute",
        params: { script },
        providerExecuted: false,
      }),
    ],
  })

const toolResult = (id: string, result: string) =>
  Prompt.makeMessage("tool", {
    content: [
      Prompt.makePart("tool-result", {
        id,
        name: "execute",
        isFailure: false,
        result,
        providerExecuted: false,
      }),
    ],
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

describe("Compaction.summarizerPrompt with images", () => {
  const messages = [
    userWithImage("look at this", "shot.png", tinyPng),
    assistantText("It is a red rectangle."),
    assistantCall("c1", "await readFile({ path: 'shot.png' })"),
    toolResult("c1", "Image attached: shot.png"),
    // The part readFile injected for the next turn.
    userWithImage("", "shot.png", tinyPng),
    assistantText("Confirmed."),
  ]

  it("stubs image parts instead of rendering their bytes", () => {
    const prompt = Compaction.summarizerPrompt({
      previousSummary: Option.none(),
      messages,
    })
    const rendered = promptJson(prompt)
    assert.notInclude(rendered, base64)
    assert.isFalse(hasFileParts(prompt))
    assert.include(rendered, "[image: shot.png omitted]")
    // The caption around the image survives.
    assert.include(rendered, "look at this")
    assert.include(rendered, "Image attached: shot.png")
  })

  it("stubs an unnamed image", () => {
    const prompt = Compaction.summarizerPrompt({
      previousSummary: Option.none(),
      messages: [
        Prompt.makeMessage("user", {
          content: [
            Prompt.makePart("text", { text: "no name" }),
            Prompt.makePart("file", { mediaType: "image/png", data: tinyPng }),
          ],
        }),
        assistantText("ok"),
      ],
    })
    const rendered = promptJson(prompt)
    assert.notInclude(rendered, base64)
    assert.match(rendered, /\[image(: [^\]]+)? omitted\]/)
  })

  it("stubs base64-string image data too", () => {
    // After a persistence round trip `data` comes back as a base64 string.
    const prompt = Compaction.summarizerPrompt({
      previousSummary: Option.none(),
      messages: [
        Prompt.makeMessage("user", {
          content: [
            Prompt.makePart("file", {
              mediaType: "image/png",
              fileName: "shot.png",
              data: base64,
            }),
          ],
        }),
        assistantText("ok"),
      ],
    })
    const rendered = promptJson(prompt)
    assert.notInclude(rendered, base64)
    assert.include(rendered, "[image: shot.png omitted]")
  })
})

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

describe("Compaction.estimateTokens with images", () => {
  it("counts image bytes so a large image trips the threshold", () => {
    const big = encodePng({ width: 400, height: 400, pixel: noisePixel })
    const withImage = Prompt.fromMessages([
      userWithImage("see", "big.png", big),
    ])
    const withoutImage = Prompt.fromMessages([user("see")])
    const config = { ...Compaction.defaultConfig, contextWindow: 300_000 }
    assert.isAbove(
      Compaction.estimateTokens(withImage),
      Compaction.estimateTokens(withoutImage) + 100_000,
    )
    assert.isTrue(
      Compaction.shouldCompact({
        prompt: withImage,
        contextTokens: undefined,
        config,
      }),
    )
  })
})

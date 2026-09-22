import { assert, describe, it } from "@effect/vitest"
import * as Base64 from "effect/encoding/Base64"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Prompt from "effect/ai/Prompt"
import * as Compaction from "./Compaction.ts"

const text = (value: string) => Prompt.makePart("text", { text: value })
const user = (value: string) =>
  Prompt.makeMessage("user", { content: [text(value)] })

// Estimation treats image payloads as opaque; no image decoder is involved.
const imageMessage = (size: number) =>
  Prompt.makeMessage("user", {
    content: [
      text("Describe this screenshot"),
      Prompt.makePart("file", {
        mediaType: "image/png",
        fileName: "screenshot.png",
        data: new Uint8Array(size).fill(137),
      }),
    ],
  })

// ACP persists history through this same JSON codec in its schema store.
const historyCodec = Schema.toCodecJson(Prompt.Prompt)
const reload = (prompt: Prompt.Prompt) =>
  Schema.decodeSync(historyCodec)(Schema.encodeSync(historyCodec)(prompt))

const toolCall = Prompt.makeMessage("assistant", {
  content: [
    Prompt.makePart("reasoning", { text: "Inspect the screenshot first." }),
    Prompt.makePart("tool-call", {
      id: "c1",
      name: "execute",
      params: { script: 'console.log(await readFile({ path: "README.md" }))' },
      providerExecuted: false,
    }),
  ],
})
const toolResult = (result: string) =>
  Prompt.makeMessage("tool", {
    content: [
      Prompt.makePart("tool-result", {
        id: "c1",
        name: "execute",
        result,
        isFailure: false,
        providerExecuted: false,
      }),
    ],
  })

describe("Compaction image token estimates", () => {
  for (const representation of ["binary", "reloaded base64"] as const) {
    const history = (size: number) => {
      const prompt = Prompt.fromMessages([imageMessage(size)])
      return representation === "binary" ? prompt : reload(prompt)
    }

    it(`${representation}: prompt estimate does not scale with image bytes`, () => {
      assert.strictEqual(
        Compaction.estimateTokens(history(1024 * 1024)),
        Compaction.estimateTokens(history(32)),
      )
    })

    it(`${representation}: message estimate does not scale with image bytes`, () => {
      assert.strictEqual(
        Compaction.estimateMessageTokens(history(1024 * 1024).content[0]!),
        Compaction.estimateMessageTokens(history(32).content[0]!),
      )
    })

    it(`${representation}: one screenshot does not trigger compaction without usage`, () => {
      assert.isFalse(
        Compaction.shouldCompact({
          prompt: history(1024 * 1024),
          contextTokens: undefined,
          config: Compaction.defaultConfig,
        }),
      )
    })

    it(`${representation}: a recent screenshot does not force an unnecessary cut`, () => {
      const prompt = Prompt.fromMessages([
        user("Earlier question"),
        ...history(1024 * 1024).content,
        user("What changed?"),
      ])
      assert.isTrue(
        Option.isNone(
          Compaction.split(prompt, Compaction.defaultConfig.keepRecentTokens),
        ),
      )
    })

    it(`${representation}: a screenshot does not cause reasoning or tool output to be trimmed`, () => {
      const kept = [
        toolCall,
        toolResult("output ".repeat(1000)),
        ...history(1024 * 1024).content,
      ]
      assert.isTrue(
        Compaction.trimKept(kept, Compaction.defaultConfig.keepRecentTokens) ===
          kept,
      )
    })

    it(`${representation}: still counts text alongside an image`, () => {
      const original = history(32).content[0]!
      assert.strictEqual(original.role, "user")
      if (original.role !== "user") return
      const extended = Prompt.makeMessage("user", {
        content: [
          text("Describe this screenshot" + "x".repeat(4000)),
          original.content[1]!,
        ],
      })
      assert.strictEqual(
        Compaction.estimateMessageTokens(extended) -
          Compaction.estimateMessageTokens(original),
        1000,
      )
      assert.strictEqual(
        Compaction.estimateTokens(Prompt.fromMessages([extended])) -
          Compaction.estimateTokens(Prompt.fromMessages([original])),
        1000,
      )
    })
  }

  it("preserves estimates across the binary-to-base64 persistence round trip", () => {
    const prompt = Prompt.fromMessages([imageMessage(1024)])
    const restored = reload(prompt)
    const message = restored.content[0]!
    assert.strictEqual(message.role, "user")
    if (message.role !== "user") return
    const image = message.content[1]!
    assert.strictEqual(image.type, "file")
    if (image.type !== "file") return
    assert.strictEqual(
      image.data,
      Base64.encode(new Uint8Array(1024).fill(137)),
    )
    assert.strictEqual(
      Compaction.estimateTokens(restored),
      Compaction.estimateTokens(prompt),
    )
    assert.strictEqual(
      Compaction.estimateMessageTokens(message),
      Compaction.estimateMessageTokens(prompt.content[0]!),
    )
  })

  it("charges for each image rather than ignoring all file parts", () => {
    const one = imageMessage(32)
    const two = Prompt.makeMessage("user", {
      content: [...one.content, one.content[1]!],
    })
    for (const message of [one, two]) {
      assert.isAbove(
        Compaction.estimateMessageTokens(message),
        Compaction.estimateMessageTokens(user("Describe this screenshot")),
      )
    }
    assert.isAbove(
      Compaction.estimateMessageTokens(two),
      Compaction.estimateMessageTokens(one),
    )
    assert.isAbove(
      Compaction.estimateTokens(Prompt.fromMessages([two])),
      Compaction.estimateTokens(Prompt.fromMessages([one])),
    )
  })
})

describe("Compaction non-image token estimates", () => {
  const messages = [
    Prompt.makeMessage("system", { content: "You are a test." }),
    user('Text with "quotes", a newline\n and Unicode: 日本語'),
    toolCall,
    toolResult("output ".repeat(1000)),
  ]

  it("preserves JSON-length accounting for text, reasoning, tool calls and results", () => {
    for (const message of messages) {
      assert.strictEqual(
        Compaction.estimateMessageTokens(message),
        Math.ceil(JSON.stringify(message).length / 4),
      )
    }
    const prompt = Prompt.fromMessages(messages)
    assert.strictEqual(
      Compaction.estimateTokens(prompt),
      Math.ceil(JSON.stringify(prompt.content).length / 4),
    )
  })

  it("still triggers compaction for large text and tool output", () => {
    for (const message of [
      user("x".repeat(900_000)),
      toolResult("x".repeat(900_000)),
    ]) {
      assert.isTrue(
        Compaction.shouldCompact({
          prompt: Prompt.fromMessages([message]),
          contextTokens: undefined,
          config: Compaction.defaultConfig,
        }),
      )
    }
  })
})

import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Image from "./Image.ts"
import {
  dimensions,
  encodePng,
  noisePixel,
  tinyPng,
} from "./fixtures/TestImages.ts"

const base64Length = (bytes: Uint8Array) => Encoding.encodeBase64(bytes).length

describe("Image.prepare", () => {
  it.effect("passes an in-limit image through unchanged", () =>
    Effect.gen(function* () {
      assert.strictEqual(Image.maxDimension, 2000)
      assert.strictEqual(Image.maxBytes, 5 * 1024 * 1024)
      const prepared = yield* Image.prepare({
        data: tinyPng,
        mediaType: "image/png",
      })
      assert.deepStrictEqual(prepared, {
        data: tinyPng,
        mediaType: "image/png",
      })
    }),
  )

  it.effect("resizes to the dimension cap while preserving aspect ratio", () =>
    Effect.gen(function* () {
      const prepared = yield* Image.prepare({
        data: encodePng({ width: 2500, height: 100 }),
        mediaType: "image/png",
      })
      assert.deepStrictEqual(dimensions(prepared.data), {
        width: 2000,
        height: 80,
      })
      assert.isAtMost(base64Length(prepared.data), Image.maxBytes)
    }),
  )

  it.effect("re-encodes an image over the base64 byte cap", () =>
    Effect.gen(function* () {
      // Exercise the byte budget independently of the dimension cap, without a multi-MB fixture.
      const data = encodePng({ width: 64, height: 64, pixel: noisePixel })
      const limits = { maxDimension: 64, maxBytes: 2000 }
      assert.isAbove(base64Length(data), limits.maxBytes)
      const prepared = yield* Image.prepare({
        data,
        mediaType: "image/png",
        limits,
      })
      assert.isAtMost(base64Length(prepared.data), limits.maxBytes)
      const size = dimensions(prepared.data)
      assert.isAtMost(size.width, limits.maxDimension)
      assert.isAtMost(size.height, limits.maxDimension)
    }),
  )

  it.effect("rejects an image that cannot fit even after resizing", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Image.prepare({
          data: tinyPng,
          mediaType: "image/png",
          limits: { maxDimension: 2, maxBytes: 40 },
        }),
      )
      assert.strictEqual(error._tag, "ImageError")
      assert.strictEqual(error.reason, "TooLarge")
    }),
  )

  it.effect("rejects undecodable bytes with a typed error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Image.prepare({
          data: new TextEncoder().encode("not a png"),
          mediaType: "image/png",
        }),
      )
      assert.strictEqual(error._tag, "ImageError")
      assert.strictEqual(error.reason, "Decode")
    }),
  )
})

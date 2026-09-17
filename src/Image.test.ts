/**
 * Contract for the `Image` module (src/Image.ts): media type detection and
 * the shared size limits applied to every image before it reaches a model,
 * whether it arrived over ACP or through `readFile`.
 *
 * Limits follow OpenCode: 2000x2000 pixels and 5MB of base64 after resize.
 * Images inside the limits pass through byte-for-byte. Larger images are
 * resized with Photon (Lanczos3), re-encoded as PNG then JPEG at decreasing
 * quality, shrunk and retried, and rejected with an `ImageError` when they
 * still do not fit.
 */
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Option from "effect/Option"
import * as Image from "./Image.ts"
import {
  dimensions,
  encodePng,
  equalBytes,
  gifHeader,
  isJpeg,
  isPng,
  noisePixel,
  tinyPng,
  webpHeader,
} from "./fixtures/TestImages.ts"

const base64Length = (bytes: Uint8Array) => Encoding.encodeBase64(bytes).length

describe("Image.limits", () => {
  it("hardcodes the OpenCode limits", () => {
    assert.strictEqual(Image.maxDimension, 2000)
    assert.strictEqual(Image.maxBytes, 5 * 1024 * 1024)
  })
})

describe("Image.mediaTypeFromPath", () => {
  it("maps the supported raster extensions", () => {
    assert.deepStrictEqual(
      Image.mediaTypeFromPath("shot.png"),
      Option.some("image/png"),
    )
    assert.deepStrictEqual(
      Image.mediaTypeFromPath("photo.jpg"),
      Option.some("image/jpeg"),
    )
    assert.deepStrictEqual(
      Image.mediaTypeFromPath("photo.JPEG"),
      Option.some("image/jpeg"),
    )
    assert.deepStrictEqual(
      Image.mediaTypeFromPath("anim.gif"),
      Option.some("image/gif"),
    )
    assert.deepStrictEqual(
      Image.mediaTypeFromPath("/abs/dir/pic.webp"),
      Option.some("image/webp"),
    )
  })

  it("treats svg and non-image files as text", () => {
    assert.deepStrictEqual(Image.mediaTypeFromPath("logo.svg"), Option.none())
    assert.deepStrictEqual(Image.mediaTypeFromPath("README.md"), Option.none())
    assert.deepStrictEqual(
      Image.mediaTypeFromPath("src/Image.ts"),
      Option.none(),
    )
    assert.deepStrictEqual(Image.mediaTypeFromPath("noext"), Option.none())
  })
})

describe("Image.mediaTypeFromBytes", () => {
  it("sniffs png, jpeg, gif and webp magic bytes", () => {
    assert.deepStrictEqual(
      Image.mediaTypeFromBytes(tinyPng),
      Option.some("image/png"),
    )
    assert.deepStrictEqual(
      Image.mediaTypeFromBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])),
      Option.some("image/jpeg"),
    )
    assert.deepStrictEqual(
      Image.mediaTypeFromBytes(gifHeader),
      Option.some("image/gif"),
    )
    assert.deepStrictEqual(
      Image.mediaTypeFromBytes(webpHeader),
      Option.some("image/webp"),
    )
  })

  it("does not recognise text or svg as an image", () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    )
    assert.deepStrictEqual(Image.mediaTypeFromBytes(svg), Option.none())
    assert.deepStrictEqual(
      Image.mediaTypeFromBytes(new TextEncoder().encode("hello")),
      Option.none(),
    )
    assert.deepStrictEqual(
      Image.mediaTypeFromBytes(new Uint8Array(0)),
      Option.none(),
    )
  })
})

describe("Image.prepare", () => {
  it.effect("passes an in-limit image through unchanged", () =>
    Effect.gen(function* () {
      const prepared = yield* Image.prepare({
        data: tinyPng,
        mediaType: "image/png",
      })
      assert.strictEqual(prepared.mediaType, "image/png")
      assert.isTrue(equalBytes(prepared.data, tinyPng))
    }),
  )

  it.effect("resizes an image wider than the dimension cap", () =>
    Effect.gen(function* () {
      const wide = encodePng({ width: 2500, height: 100 })
      const prepared = yield* Image.prepare({
        data: wide,
        mediaType: "image/png",
      })
      assert.isTrue(isPng(prepared.data) || isJpeg(prepared.data))
      const size = dimensions(prepared.data)
      assert.isAtMost(size.width, Image.maxDimension)
      assert.isAtMost(size.height, Image.maxDimension)
      // Aspect ratio is preserved: 2500x100 scales to 2000x80.
      assert.strictEqual(size.width, 2000)
      assert.isAtMost(Math.abs(size.height - 80), 1)
      assert.isAtMost(base64Length(prepared.data), Image.maxBytes)
      assert.include(["image/png", "image/jpeg"], prepared.mediaType)
    }),
  )

  it.effect(
    "brings an image over the byte cap under it with png, then jpeg, then shrinking",
    () =>
      Effect.gen(function* () {
        // Incompressible noise: ~14.5MB as PNG, well over 5MB of base64 even
        // after the dimension resize.
        const noise = encodePng({
          width: 2200,
          height: 2200,
          pixel: noisePixel,
        })
        assert.isAbove(base64Length(noise), Image.maxBytes)
        const prepared = yield* Image.prepare({
          data: noise,
          mediaType: "image/png",
        })
        const size = dimensions(prepared.data)
        assert.isAtMost(size.width, Image.maxDimension)
        assert.isAtMost(size.height, Image.maxDimension)
        assert.isAtMost(base64Length(prepared.data), Image.maxBytes)
        assert.strictEqual(
          prepared.mediaType,
          isJpeg(prepared.data) ? "image/jpeg" : "image/png",
        )
      }),
    { timeout: 60_000 },
  )

  it.effect(
    "rejects an image that still exceeds the limits after resizing",
    () =>
      Effect.gen(function* () {
        // `limits` is a test seam, not a user-facing knob: it lets the reject
        // path run without a multi-hundred-megabyte fixture.
        const noise = encodePng({ width: 300, height: 300, pixel: noisePixel })
        // A defect here fails the test: the reject must be a typed failure.
        const error = yield* Effect.flip(
          Image.prepare({
            data: noise,
            mediaType: "image/png",
            limits: { maxDimension: 200, maxBytes: 40 },
          }),
        )
        assert.strictEqual(error._tag, "ImageError")
        assert.strictEqual(error.reason, "TooLarge")
      }),
  )

  it.effect("rejects bytes that do not decode as an image", () =>
    Effect.gen(function* () {
      const garbage = new TextEncoder().encode(
        "definitely not a png".repeat(100),
      )
      const error = yield* Effect.flip(
        Image.prepare({ data: garbage, mediaType: "image/png" }),
      )
      assert.strictEqual(error._tag, "ImageError")
      assert.strictEqual(error.reason, "Decode")
    }),
  )
})

import * as Photon from "@silvia-odwyer/photon-node"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Option from "effect/Option"
import { vi } from "vitest"
import * as Image from "./Image.ts"
import {
  dimensions,
  encodePng,
  noisePixel,
  oversizedFrameHeaders,
  oversizedHeaders,
  supportedImages,
  tinyPng,
} from "./fixtures/TestImages.ts"

/** Optionally block decoding so crafted headers can never reach Photon. */
const withDecoderSpy = <A, E, R>(
  f: (calls: () => number) => Effect.Effect<A, E, R>,
  blockDecoding = false,
) =>
  Effect.suspend(() => {
    const spy = vi.spyOn(Photon.PhotonImage, "new_from_byteslice")
    if (blockDecoding) {
      spy.mockImplementation(() => {
        throw new Error("Header-only fixture must not reach the decoder")
      })
    }
    return f(() => spy.mock.calls.length).pipe(
      Effect.ensuring(Effect.sync(() => spy.mockRestore())),
    )
  })

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

// =============================================================================
// Input budget: what may reach the decoder at all
//
// Two bounds sit in front of Photon on every path. `maxInputBytes` caps the
// encoded input (20 MiB, the same number the HTTP fetch already uses), and
// `maxInputPixels` caps the canvas declared in the image header, because a
// small, highly compressible file can expand to gigabytes of RGBA inside the
// decoder before `prepare` ever reads a width. Both checks run before any
// decoding; the fixtures below have no pixels, so a decoder call would fail.
// =============================================================================

describe("Image input budget", () => {
  it("pins the shared ceilings", () => {
    assert.strictEqual(Image.maxInputBytes, 20 * 1024 * 1024)
    assert.strictEqual(Image.maxInputPixels, 50_000_000)
  })

  it.effect("reads dimensions from the header without decoding", () =>
    withDecoderSpy((decoderCalls) =>
      Effect.sync(() => {
        for (const image of supportedImages) {
          assert.deepStrictEqual(
            Option.getOrThrow(Image.dimensions(image.data)),
            dimensions(image.data),
            image.mediaType,
          )
        }
        // `dimensions` above is the Photon-backed fixture helper; reset.
        const baseline = decoderCalls()
        for (const header of oversizedHeaders) {
          assert.deepStrictEqual(
            Image.dimensions(header.data),
            Option.some({ width: header.width, height: header.height }),
            header.mediaType,
          )
        }
        assert.deepStrictEqual(
          Image.dimensions(new TextEncoder().encode("not an image")),
          Option.none(),
        )
        assert.strictEqual(decoderCalls(), baseline)
      }),
    ),
  )

  it.effect("rejects an oversized canvas in every format before decoding", () =>
    withDecoderSpy(
      (decoderCalls) =>
        Effect.gen(function* () {
          const headers = [...oversizedHeaders, ...oversizedFrameHeaders]
          const results = []
          for (const header of headers) {
            assert.isAbove(header.width * header.height, Image.maxInputPixels)
            const baseline = decoderCalls()
            const error = yield* Effect.flip(
              Image.prepare({ data: header.data, mediaType: header.mediaType }),
            )
            results.push({
              mediaType: header.mediaType,
              tag: error._tag,
              reason: error.reason,
              decoderCalls: decoderCalls() - baseline,
            })
          }
          assert.deepStrictEqual(
            results,
            headers.map((header) => ({
              mediaType: header.mediaType,
              tag: "ImageError",
              reason: "TooLarge",
              decoderCalls: 0,
            })),
          )
        }),
      true,
    ),
  )

  it.effect("rejects input over the byte ceiling before decoding", () =>
    withDecoderSpy((decoderCalls) =>
      Effect.gen(function* () {
        // A real PNG header followed by padding: over the ceiling by one byte.
        const data = new Uint8Array(20 * 1024 * 1024 + 1)
        data.set(tinyPng)
        const error = yield* Effect.flip(
          Image.prepare({ data, mediaType: "image/png" }),
        )
        assert.strictEqual(error._tag, "ImageError")
        assert.strictEqual(error.reason, "TooLarge")
        assert.strictEqual(decoderCalls(), 0, "the decoder must not run")
      }),
    ),
  )

  it.effect("does not send undecodable bytes to the decoder", () =>
    withDecoderSpy((decoderCalls) =>
      Effect.gen(function* () {
        yield* Effect.flip(
          Image.prepare({
            data: new TextEncoder().encode("not a png"),
            mediaType: "image/png",
          }),
        )
        assert.strictEqual(decoderCalls(), 0)
      }),
    ),
  )
})

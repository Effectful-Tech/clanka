/**
 * Image handling shared by ACP prompt ingest and the `readFile` tool.
 *
 * - Media type detection by extension and by magic bytes.
 * - The size limits every image goes through before it reaches a model
 *   (OpenCode's numbers): 2000x2000 pixels and 5MB of base64. Images inside
 *   the limits pass through untouched; larger ones are resized with Photon
 *   (Lanczos3), re-encoded as PNG then JPEG at decreasing quality, shrunk and
 *   retried, and rejected when they still do not fit.
 * - Prompt helpers for models that cannot take images: strip the parts and
 *   leave an explicit `[image: <name> omitted]` note.
 *
 * @since 1.0.0
 */
import type * as Photon from "@silvia-odwyer/photon-node"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import type * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type * as AiError from "effect/unstable/ai/AiError"
import * as Prompt from "effect/unstable/ai/Prompt"

/**
 * @since 1.0.0
 * @category Models
 */
export const ImageMediaType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
])

/**
 * @since 1.0.0
 * @category Models
 */
export type ImageMediaType = typeof ImageMediaType.Type

/**
 * @since 1.0.0
 * @category Models
 */
export interface ImageData {
  readonly data: Uint8Array
  readonly mediaType: ImageMediaType
}

/**
 * @since 1.0.0
 * @category Models
 */
export interface Limits {
  readonly maxDimension: number
  readonly maxBytes: number
}

/**
 * @since 1.0.0
 * @category Errors
 */
export class ImageError extends Schema.TaggedError<ImageError>()("ImageError", {
  reason: Schema.Literals(["TooLarge", "Decode"]),
  message: Schema.String,
}) {}

// =============================================================================
// Limits
// =============================================================================

/**
 * Maximum width and height, in pixels.
 *
 * @since 1.0.0
 * @category Limits
 */
export const maxDimension = 2000

/**
 * Maximum size of the base64-encoded image, in bytes.
 *
 * @since 1.0.0
 * @category Limits
 */
export const maxBytes = 5 * 1024 * 1024

/**
 * Maximum encoded input size before decoding.
 * @since 1.0.0
 * @category Limits
 */
export const maxInputBytes = 20 * 1024 * 1024

/**
 * Maximum declared canvas or frame area before allocating decoder buffers.
 * @since 1.0.0
 * @category Limits
 */
export const maxInputPixels = 50_000_000

/**
 * Stat first, then bound the actual read independently of file growth.
 * @since 1.0.0
 * @category Input
 */
export const readBoundedFile = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: string,
) {
  const tooLarge = () =>
    new ImageError({
      reason: "TooLarge",
      message: `Image ${path} exceeds the ${maxInputBytes} byte input limit`,
    })
  const stat = yield* fs.stat(path)
  if (stat.size > maxInputBytes) return yield* tooLarge()
  // The extra byte detects growth past the ceiling without reading the rest.
  return yield* collectInput(
    fs.stream(path, {
      chunkSize: 64 * 1024,
      bytesToRead: maxInputBytes + 1,
    }),
    tooLarge,
  )
})

/**
 * Collect image input, rejecting overflow before retaining the next chunk.
 * @since 1.0.0
 * @category Input
 */
export const collectInput = Effect.fnUntraced(function* <E, R, E2>(
  stream: Stream.Stream<Uint8Array, E, R>,
  tooLarge: () => E2,
) {
  const chunks: Array<Uint8Array> = []
  let size = 0
  yield* Stream.runForEach(stream, (chunk) => {
    if (chunk.length > maxInputBytes - size) return Effect.fail(tooLarge())
    size += chunk.length
    chunks.push(chunk)
    return Effect.void
  })
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
})

const defaultLimits: Limits = { maxDimension, maxBytes }

/** JPEG qualities tried, in order, when the PNG re-encode is too large. */
const jpegQualities = [85, 70, 55, 40]

/** Scale applied on every shrink-and-retry round. */
const shrinkFactor = 0.75

/** Shrink rounds attempted before giving up. */
const maxShrinkRounds = 6

// =============================================================================
// Media type detection
// =============================================================================

const extensions: Record<string, ImageMediaType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
}

/**
 * Media type from a file extension. SVG and every non-raster extension is
 * `None`, so those files keep being read as text.
 *
 * @since 1.0.0
 * @category Detection
 */
export const mediaTypeFromPath = (
  path: string,
): Option.Option<ImageMediaType> => {
  const base = path.slice(
    Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1,
  )
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return Option.none()
  return Option.fromNullishOr(extensions[base.slice(dot + 1).toLowerCase()])
}

const startsWith = (
  bytes: Uint8Array,
  prefix: ReadonlyArray<number>,
  offset = 0,
) =>
  bytes.length >= offset + prefix.length &&
  prefix.every((byte, i) => bytes[offset + i] === byte)

const ascii = (text: string): ReadonlyArray<number> =>
  Array.from(text, (char) => char.charCodeAt(0))

/**
 * Media type from the magic bytes at the start of the data.
 *
 * @since 1.0.0
 * @category Detection
 */
export const mediaTypeFromBytes = (
  bytes: Uint8Array,
): Option.Option<ImageMediaType> => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return Option.some("image/png")
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return Option.some("image/jpeg")
  }
  if (
    startsWith(bytes, ascii("GIF87a")) ||
    startsWith(bytes, ascii("GIF89a"))
  ) {
    return Option.some("image/gif")
  }
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) {
    return Option.some("image/webp")
  }
  return Option.none()
}

const validDimensions = (width: number, height: number) =>
  width > 0 && height > 0 ? Option.some({ width, height }) : Option.none()

/**
 * Read conservative dimension bounds without decoding pixels, including inner
 * frames in container formats. Truncated or malformed headers are rejected
 * before they can reach Photon; over-budget dimensions stop parsing early.
 * @since 1.0.0
 * @category Detection
 */
export const dimensions = (
  bytes: Uint8Array,
): Option.Option<{ width: number; height: number }> => {
  const type = mediaTypeFromBytes(bytes)
  if (Option.isNone(type)) return Option.none()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  switch (type.value) {
    case "image/png":
      if (
        bytes.length < 33 ||
        view.getUint32(8) !== 13 ||
        !startsWith(bytes, ascii("IHDR"), 12)
      )
        return Option.none()
      return validDimensions(view.getUint32(16), view.getUint32(20))
    case "image/gif": {
      if (bytes.length < 13) return Option.none()
      let width = view.getUint16(6, true)
      let height = view.getUint16(8, true)
      if (width === 0 || height === 0) return Option.none()
      if (width * height > maxInputPixels) return validDimensions(width, height)
      let offset = 13
      const skipColorTable = (packed: number) => {
        if (packed & 0x80) offset += 3 * (1 << ((packed & 7) + 1))
        return offset <= bytes.length
      }
      const skipSubBlocks = () => {
        while (offset < bytes.length) {
          const length = view.getUint8(offset++)
          if (length === 0) return true
          if (length > bytes.length - offset) return false
          offset += length
        }
        return false
      }
      if (!skipColorTable(view.getUint8(10))) return Option.none()
      let hasFrame = false
      while (offset < bytes.length) {
        const tag = view.getUint8(offset++)
        if (tag === 0x3b) {
          return hasFrame ? validDimensions(width, height) : Option.none()
        }
        if (tag === 0x21) {
          // Extension label followed by length-prefixed sub-blocks.
          if (offset >= bytes.length) return Option.none()
          offset++
          if (!skipSubBlocks()) return Option.none()
          continue
        }
        if (tag !== 0x2c || bytes.length - offset < 9) return Option.none()
        const frameWidth = view.getUint16(offset + 4, true)
        const frameHeight = view.getUint16(offset + 6, true)
        if (frameWidth === 0 || frameHeight === 0) return Option.none()
        // The decoder allocates the frame independently of the logical screen.
        width = Math.max(width, frameWidth)
        height = Math.max(height, frameHeight)
        if (width * height > maxInputPixels)
          return validDimensions(width, height)
        const packed = view.getUint8(offset + 8)
        offset += 9
        if (!skipColorTable(packed) || offset >= bytes.length)
          return Option.none()
        offset++ // LZW minimum code size; pixel decoding validates its value.
        if (!skipSubBlocks()) return Option.none()
        hasFrame = true
      }
      return Option.none()
    }
    case "image/jpeg": {
      let offset = 2
      while (offset < bytes.length) {
        if (view.getUint8(offset++) !== 0xff) return Option.none()
        // JPEG permits padding FF bytes before a marker.
        while (offset < bytes.length && view.getUint8(offset) === 0xff) offset++
        if (offset >= bytes.length) return Option.none()
        const marker = view.getUint8(offset++)
        if (
          marker === 0xda ||
          marker === 0xd9 ||
          marker === 0 ||
          marker === 0xd8
        ) {
          return Option.none()
        }
        if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue
        if (offset + 2 > bytes.length) return Option.none()
        const length = view.getUint16(offset)
        if (length < 2 || length > bytes.length - offset) return Option.none()
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc
        ) {
          if (
            length < 8 ||
            view.getUint8(offset + 7) === 0 ||
            length !== 8 + 3 * view.getUint8(offset + 7)
          )
            return Option.none()
          return validDimensions(
            view.getUint16(offset + 5),
            view.getUint16(offset + 3),
          )
        }
        offset += length
      }
      return Option.none()
    }
    case "image/webp": {
      if (bytes.length < 20) return Option.none()
      const end = view.getUint32(4, true) + 8
      if (end < 20 || end > bytes.length) return Option.none()
      const u24 = (offset: number) =>
        view.getUint8(offset) |
        (view.getUint8(offset + 1) << 8) |
        (view.getUint8(offset + 2) << 16)
      let width = 0
      let height = 0
      let hasFrame = false
      const include = (w: number, h: number) => {
        if (w === 0 || h === 0) return false
        width = Math.max(width, w)
        height = Math.max(height, h)
        return true
      }
      // Only one level of nesting is legal: ANMF contains frame chunks, not ANMF.
      const scan = (
        start: number,
        limit: number,
        inFrame: boolean,
      ): boolean => {
        let offset = start
        while (offset < limit) {
          if (limit - offset < 8) return false
          const length = view.getUint32(offset + 4, true)
          const data = offset + 8
          const paddedLength = length + (length & 1)
          if (paddedLength > limit - data) return false
          if (startsWith(bytes, ascii("VP8X"), offset)) {
            if (inFrame || offset !== 12 || length !== 10) return false
            include(u24(data + 4) + 1, u24(data + 7) + 1)
          } else if (startsWith(bytes, ascii("VP8L"), offset)) {
            if (
              length < 5 ||
              view.getUint8(data) !== 0x2f ||
              view.getUint8(data + 4) >> 5 !== 0
            )
              return false
            include(
              (view.getUint8(data + 1) |
                ((view.getUint8(data + 2) & 0x3f) << 8)) +
                1,
              ((view.getUint8(data + 2) >> 6) |
                (view.getUint8(data + 3) << 2) |
                ((view.getUint8(data + 4) & 0x0f) << 10)) +
                1,
            )
            hasFrame = true
          } else if (startsWith(bytes, ascii("VP8 "), offset)) {
            if (
              length < 10 ||
              (view.getUint8(data) & 1) !== 0 ||
              !startsWith(bytes, [0x9d, 0x01, 0x2a], data + 3) ||
              !include(
                view.getUint16(data + 6, true) & 0x3fff,
                view.getUint16(data + 8, true) & 0x3fff,
              )
            )
              return false
            hasFrame = true
          } else if (startsWith(bytes, ascii("ANMF"), offset)) {
            if (inFrame || length < 16) return false
            include(u24(data + 6) + 1, u24(data + 9) + 1)
            if (width * height > maxInputPixels) return true
            if (!scan(data + 16, data + length, true)) return false
          }
          // Reject over-budget headers even if the pixel payload is incomplete.
          if (width * height > maxInputPixels) return true
          offset = data + paddedLength
        }
        return true
      }
      if (!scan(12, end, false)) return Option.none()
      return hasFrame || width * height > maxInputPixels
        ? validDimensions(width, height)
        : Option.none()
    }
  }
}

/**
 * Whether a declared mime type is one of the supported image types.
 *
 * @since 1.0.0
 * @category Detection
 */
export const isImageMediaType = Schema.is(ImageMediaType)

// =============================================================================
// Resize
// =============================================================================

const base64Length = (byteLength: number) => Math.ceil(byteLength / 3) * 4

const fits = (bytes: Uint8Array, limits: Limits) =>
  base64Length(bytes.length) <= limits.maxBytes

const decode = (
  photon: typeof Photon,
  data: Uint8Array,
): Effect.Effect<Photon.PhotonImage, ImageError> =>
  Effect.try({
    try: () => {
      const image = photon.PhotonImage.new_from_byteslice(data)
      // Photon returns an empty image rather than throwing for some inputs.
      if (image.get_width() === 0 || image.get_height() === 0) {
        image.free()
        throw new Error("Image has no pixels")
      }
      return image
    },
    catch: (cause) =>
      new ImageError({
        reason: "Decode",
        message: `Could not decode image: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })

/** Encode as PNG, then JPEG at decreasing quality; `None` if nothing fits. */
const encodeWithin = (
  image: Photon.PhotonImage,
  limits: Limits,
): Option.Option<ImageData> => {
  const png = image.get_bytes()
  if (fits(png, limits))
    return Option.some({ data: png, mediaType: "image/png" })
  for (const quality of jpegQualities) {
    const jpeg = image.get_bytes_jpeg(quality)
    if (fits(jpeg, limits)) {
      return Option.some({ data: jpeg, mediaType: "image/jpeg" })
    }
  }
  return Option.none()
}

/**
 * Bring an image inside the limits.
 *
 * Images already within `limits` are returned unchanged, byte for byte.
 * Otherwise the image is decoded, scaled down to fit the dimension cap with
 * Lanczos3, and re-encoded as PNG, then as JPEG at decreasing quality. If it
 * is still over the byte cap it is shrunk by 25% and the encoding is retried,
 * up to a fixed number of rounds, after which it is rejected.
 *
 * `limits` exists so tests can exercise the reject path with a small fixture.
 * It is not a user-facing setting.
 *
 * @since 1.0.0
 * @category Resize
 */
export const prepare = Effect.fnUntraced(function* (options: {
  readonly data: Uint8Array
  readonly mediaType: ImageMediaType
  readonly limits?: Limits | undefined
}): Effect.fn.Return<ImageData, ImageError> {
  const limits = options.limits ?? defaultLimits
  if (options.data.length > maxInputBytes) {
    return yield* new ImageError({
      reason: "TooLarge",
      message: `Image exceeds the ${maxInputBytes} byte input limit`,
    })
  }
  const size = dimensions(options.data)
  if (Option.isNone(size)) {
    return yield* new ImageError({
      reason: "Decode",
      message: "Invalid or truncated image header",
    })
  }
  if (size.value.width * size.value.height > maxInputPixels) {
    return yield* new ImageError({
      reason: "TooLarge",
      message: `Image exceeds the ${maxInputPixels} pixel input limit`,
    })
  }
  const Photon = yield* Effect.tryPromise({
    try: () => import("@silvia-odwyer/photon-node"),
    catch: (cause) =>
      new ImageError({
        reason: "Decode",
        message: `Could not load image decoder: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })
  const image = yield* decode(Photon, options.data)
  let current = image
  try {
    const width = image.get_width()
    const height = image.get_height()
    const withinDimensions =
      width <= limits.maxDimension && height <= limits.maxDimension
    if (withinDimensions && fits(options.data, limits)) {
      return { data: options.data, mediaType: options.mediaType }
    }

    let scale = Math.min(
      1,
      limits.maxDimension / width,
      limits.maxDimension / height,
    )
    for (let round = 0; round <= maxShrinkRounds; round++) {
      const targetWidth = Math.max(1, Math.round(width * scale))
      const targetHeight = Math.max(1, Math.round(height * scale))
      if (
        targetWidth !== current.get_width() ||
        targetHeight !== current.get_height()
      ) {
        const resized = Photon.resize(
          image,
          targetWidth,
          targetHeight,
          Photon.SamplingFilter.Lanczos3,
        )
        if (current !== image) current.free()
        current = resized
      }
      const encoded = encodeWithin(current, limits)
      if (Option.isSome(encoded)) return encoded.value
      scale *= shrinkFactor
    }
    return yield* new ImageError({
      reason: "TooLarge",
      message: `Image is still over ${limits.maxBytes} bytes of base64 after resizing`,
    })
  } finally {
    if (current !== image) current.free()
    image.free()
  }
})

// =============================================================================
// Prompt helpers
// =============================================================================

/**
 * The text left in place of a stripped image part.
 *
 * @since 1.0.0
 * @category Prompt
 */
export const omittedText = (fileName: string | undefined): string =>
  `[image: ${fileName ?? "unnamed"} omitted]`

/**
 * Whether a prompt part is an image `file` part.
 *
 * @since 1.0.0
 * @category Prompt
 */
export const isImagePart = (part: Prompt.Part): part is Prompt.FilePart =>
  part.type === "file" && part.mediaType.startsWith("image/")

/**
 * Whether any user message in the prompt carries an image part.
 *
 * @since 1.0.0
 * @category Prompt
 */
export const hasImages = (prompt: Prompt.Prompt): boolean =>
  prompt.content.some(
    (message) => message.role === "user" && message.content.some(isImagePart),
  )

/**
 * Replace every image part with an `omittedText` text part, so a model that
 * cannot take images still sees that one was there.
 *
 * @since 1.0.0
 * @category Prompt
 */
export const stripImages = (prompt: Prompt.Prompt): Prompt.Prompt => {
  if (!hasImages(prompt)) return prompt
  return Prompt.fromMessages(
    prompt.content.map((message) => {
      if (message.role !== "user" || !message.content.some(isImagePart)) {
        return message
      }
      return Prompt.makeMessage("user", {
        content: message.content.map((part) =>
          isImagePart(part)
            ? Prompt.makePart("text", { text: omittedText(part.fileName) })
            : part,
        ),
        options: message.options,
      })
    }),
  )
}

/**
 * Build a user message carrying image parts.
 *
 * @since 1.0.0
 * @category Prompt
 */
export const userMessage = (
  images: ReadonlyArray<{
    readonly fileName: string
    readonly mediaType: ImageMediaType
    readonly data: Uint8Array
  }>,
): Prompt.UserMessage =>
  Prompt.makeMessage("user", {
    content: images.map((image) =>
      Prompt.makePart("file", {
        mediaType: image.mediaType,
        fileName: image.fileName,
        data: image.data,
      }),
    ),
  })

/**
 * Bytes of a `file` part, whichever representation it carries. Byte arrays
 * come back from persistence as base64 strings.
 *
 * @since 1.0.0
 * @category Prompt
 */
export const partBytes = (part: Prompt.FilePart): Option.Option<Uint8Array> => {
  if (part.data instanceof Uint8Array) return Option.some(part.data)
  if (part.data instanceof URL) return Option.none()
  const base64 = part.data.startsWith("data:")
    ? part.data.slice(part.data.indexOf(",") + 1)
    : part.data
  const decoded = Encoding.decodeBase64(base64)
  return decoded._tag === "Success"
    ? Option.some(decoded.success)
    : Option.none()
}

// =============================================================================
// Provider errors
// =============================================================================

const unsupportedImagePattern =
  /image[^.]{0,80}(only supported|not supported|unsupported|does not support|cannot|can't|invalid)|(only supported|not supported|unsupported|does not support|cannot|can't|invalid)[^.]{0,80}image/i

/**
 * Whether a provider error looks like a rejection of image input, so the
 * turn can be retried once without the images.
 *
 * @since 1.0.0
 * @category Provider errors
 */
export const isUnsupportedImageError = (error: AiError.AiError): boolean => {
  const reason = error.reason
  switch (reason._tag) {
    case "InvalidRequestError":
    case "UnknownError":
    case "InternalProviderError":
      return (
        reason.description !== undefined &&
        unsupportedImagePattern.test(reason.description)
      )
    default:
      return false
  }
}

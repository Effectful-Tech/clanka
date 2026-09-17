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
import * as Photon from "@silvia-odwyer/photon-node"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
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

/**
 * Whether a declared mime type is one of the supported image types.
 *
 * @since 1.0.0
 * @category Detection
 */
export const isImageMediaType = (
  mediaType: string,
): mediaType is ImageMediaType => Schema.is(ImageMediaType)(mediaType)

// =============================================================================
// Resize
// =============================================================================

const base64Length = (byteLength: number) => Math.ceil(byteLength / 3) * 4

const fits = (bytes: Uint8Array, limits: Limits) =>
  base64Length(bytes.length) <= limits.maxBytes

const decode = (
  data: Uint8Array,
): Effect.Effect<Photon.PhotonImage, ImageError> =>
  Effect.try({
    try: () => {
      const image = Photon.PhotonImage.new_from_byteslice(data)
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
export const prepare = (options: {
  readonly data: Uint8Array
  readonly mediaType: ImageMediaType
  readonly limits?: Limits | undefined
}): Effect.Effect<ImageData, ImageError> =>
  Effect.gen(function* () {
    const limits = options.limits ?? defaultLimits
    const image = yield* decode(options.data)
    try {
      let width = image.get_width()
      let height = image.get_height()
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
      let current = image
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
        if (Option.isSome(encoded)) {
          if (current !== image) current.free()
          return encoded.value
        }
        scale *= shrinkFactor
      }
      if (current !== image) current.free()
      return yield* new ImageError({
        reason: "TooLarge",
        message: `Image is still over ${limits.maxBytes} bytes of base64 after resizing`,
      })
    } finally {
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

/**
 * Test-only image helpers: a minimal PNG encoder plus header parsers, so the
 * vision tests can build images of arbitrary size without an image library
 * and inspect what the resizer produced.
 */
import * as Zlib from "node:zlib"
import * as Encoding from "effect/Encoding"

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const typeBytes = new TextEncoder().encode(type)
  const out = new Uint8Array(4 + 4 + data.length + 4)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(typeBytes, 4)
  out.set(data, 8)
  const crcInput = new Uint8Array(typeBytes.length + data.length)
  crcInput.set(typeBytes)
  crcInput.set(data, typeBytes.length)
  view.setUint32(8 + data.length, Zlib.crc32(crcInput))
  return out
}

/**
 * Encode an 8-bit RGB PNG. `pixel` returns `[r, g, b]` for a coordinate; the
 * default is a flat colour, which compresses to almost nothing, so the PNG
 * can exceed the dimension limit without exceeding the byte limit.
 */
export const encodePng = (options: {
  readonly width: number
  readonly height: number
  readonly pixel?: (x: number, y: number) => readonly [number, number, number]
}): Uint8Array => {
  const { width, height } = options
  const pixel = options.pixel ?? (() => [200, 30, 30] as const)
  const raw = new Uint8Array(height * (1 + width * 3))
  let offset = 0
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y)
      raw[offset++] = r
      raw[offset++] = g
      raw[offset++] = b
    }
  }
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: RGB
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const idat = new Uint8Array(Zlib.deflateSync(raw))
  const parts = [
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ]
  const total = parts.reduce((n, part) => n + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/**
 * Deterministic pseudo-random pixels. Incompressible, so a large noise PNG
 * exceeds the byte limit as well as the dimension limit.
 */
export const noisePixel = (
  x: number,
  y: number,
): readonly [number, number, number] => {
  let h = (x * 374761393 + y * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return [h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff]
}

/** A tiny valid PNG for tests that only care about the bytes round-tripping. */
export const tinyPng: Uint8Array = encodePng({ width: 4, height: 3 })

export const isPng = (bytes: Uint8Array): boolean =>
  PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)

export const isJpeg = (bytes: Uint8Array): boolean =>
  bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff

export interface Dimensions {
  readonly width: number
  readonly height: number
}

const pngDimensions = (bytes: Uint8Array): Dimensions => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

const jpegDimensions = (bytes: Uint8Array): Dimensions => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      throw new Error(`Invalid JPEG marker at ${offset}`)
    }
    const marker = bytes[offset + 1]!
    // SOFn markers (C0..CF) except DHT (C4), JPG (C8) and DAC (CC)
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return {
        height: view.getUint16(offset + 5),
        width: view.getUint16(offset + 7),
      }
    }
    const length = view.getUint16(offset + 2)
    offset += 2 + length
  }
  throw new Error("No SOF marker found in JPEG")
}

/** Width and height of a PNG or JPEG, read from the header. */
export const dimensions = (bytes: Uint8Array): Dimensions => {
  if (isPng(bytes)) return pngDimensions(bytes)
  if (isJpeg(bytes)) return jpegDimensions(bytes)
  throw new Error("Not a PNG or JPEG")
}

/** Magic-byte prefixes for the other supported formats. */
export const gifHeader: Uint8Array = new TextEncoder().encode("GIF89a")
export const webpHeader: Uint8Array = (() => {
  const out = new Uint8Array(12)
  out.set(new TextEncoder().encode("RIFF"), 0)
  out.set(new TextEncoder().encode("WEBP"), 8)
  return out
})()

/**
 * Normalise a `FilePart.data` to bytes. Providers accept base64 strings,
 * byte arrays, or URLs; after a persistence round trip a byte array comes
 * back as a base64 string, so tests must accept both.
 */
export const bytesOf = (data: string | Uint8Array | URL): Uint8Array => {
  if (data instanceof Uint8Array) return data
  if (data instanceof URL) throw new Error(`Expected inline data, got ${data}`)
  const base64 = data.startsWith("data:")
    ? data.slice(data.indexOf(",") + 1)
    : data
  const decoded = Encoding.decodeBase64(base64)
  if (decoded._tag === "Failure") throw new Error("Invalid base64 image data")
  return decoded.success
}

export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

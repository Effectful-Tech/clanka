import * as Photon from "@silvia-odwyer/photon-node"
import * as Zlib from "node:zlib"
import * as Encoding from "effect/Encoding"

export const encodePng = (options: {
  readonly width: number
  readonly height: number
  readonly pixel?: (x: number, y: number) => readonly [number, number, number]
}): Uint8Array => {
  const { width, height } = options
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.set(
        [...(options.pixel?.(x, y) ?? [200, 30, 30]), 255],
        (y * width + x) * 4,
      )
    }
  }
  const image = new Photon.PhotonImage(pixels, width, height)
  try {
    return image.get_bytes()
  } finally {
    image.free()
  }
}

export const noisePixel = (
  x: number,
  y: number,
): readonly [number, number, number] => {
  let h = (x * 374761393 + y * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return [h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff]
}

export const tinyPng = encodePng({ width: 4, height: 3 })

const encodeOtherFormats = () => {
  const image = Photon.PhotonImage.new_from_byteslice(tinyPng)
  try {
    return { jpeg: image.get_bytes_jpeg(85), webp: image.get_bytes_webp() }
  } finally {
    image.free()
  }
}

const encoded = encodeOtherFormats()
export const tinyJpeg = encoded.jpeg
export const tinyWebp = encoded.webp

/** Two 4x2 frames (red, then blue), each displayed for 100ms, looping forever. */
export const animatedGif = new Uint8Array([
  // GIF89a, logical screen, and a two-colour global palette.
  71, 73, 70, 56, 57, 97, 4, 0, 2, 0, 128, 0, 0, 255, 0, 0, 0, 0, 255,
  // NETSCAPE2.0 loop extension.
  33, 255, 11, 78, 69, 84, 83, 67, 65, 80, 69, 50, 46, 48, 3, 1, 0, 0, 0,
  // Frame 1: graphics control, image descriptor, and LZW pixels.
  33, 249, 4, 0, 10, 0, 0, 0, 44, 0, 0, 0, 0, 4, 0, 2, 0, 0, 2, 7, 4, 65, 16, 4,
  65, 16, 5, 0,
  // Frame 2 uses the blue palette entry.
  33, 249, 4, 0, 10, 0, 0, 0, 44, 0, 0, 0, 0, 4, 0, 2, 0, 0, 2, 7, 12, 195, 48,
  12, 195, 48, 5, 0, 59,
])

export const supportedImages = [
  {
    fileName: "shot.png",
    mediaType: "image/png",
    data: tinyPng,
  },
  {
    fileName: "photo.jpeg",
    mediaType: "image/jpeg",
    data: tinyJpeg,
  },
  {
    fileName: "animated.gif",
    mediaType: "image/gif",
    data: animatedGif,
  },
  {
    fileName: "picture.webp",
    mediaType: "image/webp",
    data: tinyWebp,
  },
] as const

const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0))
const u16be = (n: number) => [(n >>> 8) & 0xff, n & 0xff]
const u16le = (n: number) => [n & 0xff, (n >>> 8) & 0xff]
const u24le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff]
const u32be = (n: number) => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
]
const u32le = (n: number) => [
  n & 0xff,
  (n >>> 8) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 24) & 0xff,
]

const pngHeader = (width: number, height: number) => {
  const ihdr = [
    ...ascii("IHDR"),
    ...u32be(width),
    ...u32be(height),
    8,
    6,
    0,
    0,
    0,
  ]
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32be(13),
    ...ihdr,
    ...u32be(Zlib.crc32(new Uint8Array(ihdr))),
  ])
}

const jpegHeader = (width: number, height: number) =>
  new Uint8Array([
    0xff,
    0xd8,
    // APP0 / JFIF, as emitted by most encoders, so the parser must skip it.
    0xff,
    0xe0,
    ...u16be(16),
    ...ascii("JFIF"),
    0,
    1,
    2,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    // SOF0: length 17, 8-bit precision, height, width, 3 components.
    0xff,
    0xc0,
    ...u16be(17),
    8,
    ...u16be(height),
    ...u16be(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ])

const gifHeader = (width: number, height: number) =>
  new Uint8Array([
    ...ascii("GIF89a"),
    ...u16le(width),
    ...u16le(height),
    0,
    0,
    0,
  ])

/** Extended (VP8X) container, the only WebP form that carries a canvas size. */
const webpHeader = (width: number, height: number) =>
  new Uint8Array([
    ...ascii("RIFF"),
    ...u32le(22),
    ...ascii("WEBP"),
    ...ascii("VP8X"),
    ...u32le(10),
    0,
    0,
    0,
    0,
    ...u24le(width - 1),
    ...u24le(height - 1),
  ])

/**
 * Header-only fixtures that declare canvases far over any sane pixel budget.
 * They carry no pixel data, so nothing can decode them: a test that passes
 * one to the decoder is a test that would decode a bomb.
 */
export const oversizedHeaders = [
  {
    mediaType: "image/png",
    width: 16384,
    height: 16384,
    data: pngHeader(16384, 16384),
  },
  {
    mediaType: "image/jpeg",
    width: 65535,
    height: 65535,
    data: jpegHeader(65535, 65535),
  },
  {
    mediaType: "image/gif",
    width: 65535,
    height: 65535,
    data: gifHeader(65535, 65535),
  },
  {
    mediaType: "image/webp",
    width: 16384,
    height: 16384,
    data: webpHeader(16384, 16384),
  },
] as const

/** Small container canvases hiding 8000x8000 frames, with no pixel payload. */
export const oversizedFrameHeaders = [
  {
    mediaType: "image/webp",
    width: 8000,
    height: 8000,
    data: new Uint8Array([
      ...ascii("RIFF"),
      ...u32le(36),
      ...webpHeader(1, 1).subarray(8),
      ...ascii("VP8L"),
      ...u32le(5),
      0x2f,
      // VP8L packs width-1 and height-1 into 14 bits each.
      ...u32le(7999 | (7999 << 14)),
      0, // RIFF chunk padding, not pixel data.
    ]),
  },
  {
    mediaType: "image/gif",
    width: 8000,
    height: 8000,
    data: new Uint8Array([
      ...gifHeader(1, 1),
      0x2c, // Image descriptor.
      ...u16le(0),
      ...u16le(0),
      ...u16le(8000),
      ...u16le(8000),
      0, // No local colour table.
      2,
      0, // LZW minimum code size and empty data sub-block.
      0x3b, // Trailer.
    ]),
  },
] as const

export const dimensions = (bytes: Uint8Array) => {
  const image = Photon.PhotonImage.new_from_byteslice(bytes)
  try {
    return { width: image.get_width(), height: image.get_height() }
  } finally {
    image.free()
  }
}

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

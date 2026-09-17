import * as Photon from "@silvia-odwyer/photon-node"
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

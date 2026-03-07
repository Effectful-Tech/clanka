type Chunk = {
  readonly old: ReadonlyArray<string>
  readonly next: ReadonlyArray<string>
  readonly ctx?: string
  readonly eof?: boolean
}

type Wrapped = {
  readonly path: string
  readonly chunks: ReadonlyArray<Chunk>
}

const BEGIN = "*** Begin Patch"
const END = "*** End Patch"

const stripHeredoc = (input: string): string => {
  const match = input.match(
    /^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/,
  )
  return match?.[2] ?? input
}

const normalize = (input: string): string =>
  stripHeredoc(input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim())

const fail = (message: string): never => {
  throw new Error(`applyPatch verification failed: ${message}`)
}

const parseChunks = (
  lines: ReadonlyArray<string>,
  start: number,
  end = lines.length,
) => {
  const chunks = Array<Chunk>()
  let i = start

  while (i < end) {
    const line = lines[i]!
    if (line.startsWith("***")) {
      break
    }
    if (!line.startsWith("@@")) {
      i++
      continue
    }

    const ctx = line.slice(2).trim()
    const old = Array<string>()
    const next = Array<string>()
    let eof = false
    i++

    while (i < end) {
      const line = lines[i]!
      if (line === "*** End of File") {
        eof = true
        i++
        break
      }
      if (line.startsWith("@@") || line.startsWith("***")) {
        break
      }
      if (line.startsWith(" ")) {
        const text = line.slice(1)
        old.push(text)
        next.push(text)
      } else if (line.startsWith("-")) {
        old.push(line.slice(1))
      } else if (line.startsWith("+")) {
        next.push(line.slice(1))
      }
      i++
    }

    chunks.push({
      old,
      next,
      ...(ctx.length > 0 ? { ctx } : {}),
      ...(eof ? { eof: true } : {}),
    })
  }

  return {
    chunks,
    next: i,
  }
}

const parseWrapped = (text: string): Wrapped => {
  const lines = text.split("\n")
  const begin = lines.findIndex((line) => line.trim() === BEGIN)
  const end = lines.findIndex((line) => line.trim() === END)
  if (begin === -1 || end === -1 || begin >= end) {
    fail("Invalid patch format: missing Begin/End markers")
  }

  let i = begin + 1
  while (i < end && lines[i]!.trim() === "") {
    i++
  }
  if (i === end) {
    throw new Error("patch rejected: empty patch")
  }
  if (!lines[i]!.startsWith("*** Update File:")) {
    fail("only single-file update patches are supported")
  }
  const path = lines[i]!.slice("*** Update File:".length).trim()
  if (path.length === 0) {
    fail("missing update file path")
  }

  i++
  if (i < end && lines[i]!.startsWith("*** Move to:")) {
    fail("move patches are not supported")
  }

  const parsed = parseChunks(lines, i, end)
  if (parsed.chunks.length === 0) {
    fail("no hunks found")
  }

  i = parsed.next
  while (i < end && lines[i]!.trim() === "") {
    i++
  }
  if (i !== end) {
    fail("only one update file section is supported")
  }

  return {
    path,
    chunks: parsed.chunks,
  }
}

export const wrappedPath = (input: string): string | undefined => {
  const text = normalize(input)
  if (!text.startsWith(BEGIN)) {
    return
  }
  return parseWrapped(text).path
}

const parse = (input: string): ReadonlyArray<Chunk> => {
  const text = normalize(input)
  if (text.length === 0) {
    throw new Error("patchText is required")
  }
  if (text === `${BEGIN}\n${END}`) {
    throw new Error("patch rejected: empty patch")
  }

  if (text.startsWith(BEGIN)) {
    return parseWrapped(text).chunks
  }

  const parsed = parseChunks(text.split("\n"), 0)
  if (parsed.chunks.length === 0) {
    fail("no hunks found")
  }
  return parsed.chunks
}

const normalizeUnicode = (line: string): string =>
  line
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")

const match = (
  lines: ReadonlyArray<string>,
  part: ReadonlyArray<string>,
  from: number,
  same: (left: string, right: string) => boolean,
  eof: boolean,
): number => {
  if (eof) {
    const last = lines.length - part.length
    if (last >= from) {
      let ok = true
      for (let i = 0; i < part.length; i++) {
        if (!same(lines[last + i]!, part[i]!)) {
          ok = false
          break
        }
      }
      if (ok) {
        return last
      }
    }
  }

  for (let i = from; i <= lines.length - part.length; i++) {
    let ok = true
    for (let j = 0; j < part.length; j++) {
      if (!same(lines[i + j]!, part[j]!)) {
        ok = false
        break
      }
    }
    if (ok) {
      return i
    }
  }

  return -1
}

const seek = (
  lines: ReadonlyArray<string>,
  part: ReadonlyArray<string>,
  from: number,
  eof = false,
): number => {
  if (part.length === 0) {
    return -1
  }

  const exact = match(lines, part, from, (left, right) => left === right, eof)
  if (exact !== -1) {
    return exact
  }

  const rstrip = match(
    lines,
    part,
    from,
    (left, right) => left.trimEnd() === right.trimEnd(),
    eof,
  )
  if (rstrip !== -1) {
    return rstrip
  }

  const trim = match(
    lines,
    part,
    from,
    (left, right) => left.trim() === right.trim(),
    eof,
  )
  if (trim !== -1) {
    return trim
  }

  return match(
    lines,
    part,
    from,
    (left, right) =>
      normalizeUnicode(left.trim()) === normalizeUnicode(right.trim()),
    eof,
  )
}

const compute = (
  file: string,
  lines: ReadonlyArray<string>,
  chunks: ReadonlyArray<Chunk>,
): Array<readonly [number, number, ReadonlyArray<string>]> => {
  const out = Array<readonly [number, number, ReadonlyArray<string>]>()
  let from = 0

  for (const chunk of chunks) {
    if (chunk.ctx) {
      const at = seek(lines, [chunk.ctx], from)
      if (at === -1) {
        fail(`Failed to find context '${chunk.ctx}' in ${file}`)
      }
      from = at + 1
    }

    if (chunk.old.length === 0) {
      out.push([lines.length, 0, chunk.next])
      continue
    }

    let old = chunk.old
    let next = chunk.next
    let at = seek(lines, old, from, chunk.eof === true)
    if (at === -1 && old.at(-1) === "") {
      old = old.slice(0, -1)
      next = next.at(-1) === "" ? next.slice(0, -1) : next
      at = seek(lines, old, from, chunk.eof === true)
    }
    if (at === -1) {
      fail(`Failed to find expected lines in ${file}:\n${chunk.old.join("\n")}`)
    }

    out.push([at, old.length, next])
    from = at + old.length
  }

  out.sort((left, right) => left[0] - right[0])
  return out
}

export const patchContent = (
  file: string,
  input: string,
  patchText: string,
): string => {
  const eol = input.includes("\r\n") ? "\r\n" : "\n"
  const lines = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  if (lines.at(-1) === "") {
    lines.pop()
  }

  const out = [...lines]
  for (const [at, size, next] of compute(
    file,
    lines,
    parse(patchText),
  ).reverse()) {
    out.splice(at, size, ...next)
  }

  if (out.at(-1) !== "") {
    out.push("")
  }

  const text = out.join("\n")
  return eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text
}

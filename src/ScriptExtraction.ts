/**
 * If the given string contains code blocks, extract them all and concatenate
 * them together.
 *
 * If there are no code blocks, return the full string as is.
 *
 * For example, given the following string:
 *
 * ```
 * This is some text.
 *
 * ```js
 * console.log("Hello, world!");
 * ```
 *
 * More text here.
 *
 * ```
 * console.log("Goodbye, world!");
 * ```
 * ```
 *
 * The function should return the following string:
 *
 * ```
 * console.log("Hello, world!");
 *
 * console.log("Goodbye, world!");
 * ```
 *
 * @since 1.0.0
 */
export const extractScript = (markdown: string): string => {
  const newLine = markdown.includes("\r\n") ? "\r\n" : "\n"
  const separator = newLine + newLine
  const blocks: Array<string> = []
  const lines = markdown.split(/\r?\n/)

  let current: Array<string> | undefined
  let marker: "`" | "~" | undefined
  let openingLength = 0

  for (const line of lines) {
    if (current === undefined) {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})[^\r\n]*$/)
      if (opening) {
        current = []
        marker = opening[1]![0] as "`" | "~"
        openingLength = opening[1]!.length
      }
      continue
    }

    const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
    if (
      closing &&
      closing[1]![0] === marker &&
      closing[1]!.length >= openingLength
    ) {
      blocks.push(current.join(newLine))
      current = undefined
      marker = undefined
      openingLength = 0
      continue
    }

    current.push(line)
  }

  if (current !== undefined) {
    blocks.push(current.join(newLine))
  }

  return blocks.length === 0 ? markdown : blocks.join(separator)
}

export const stripWrappingCodeFence = (script: string): string => {
  const lines = script.split(/\r?\n/)
  if (lines.length < 2) {
    return script
  }

  let firstNonEmpty = -1
  let lastNonEmpty = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().length > 0) {
      firstNonEmpty = i
      break
    }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim().length > 0) {
      lastNonEmpty = i
      break
    }
  }

  if (
    firstNonEmpty === -1 ||
    lastNonEmpty === -1 ||
    firstNonEmpty >= lastNonEmpty
  ) {
    return script
  }

  const opening = lines[firstNonEmpty]!.match(/^ {0,3}(`{3,}|~{3,})[^\r\n]*$/)
  if (!opening) {
    return script
  }

  const closing = lines[lastNonEmpty]!.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
  if (!closing) {
    return script
  }

  if (opening[1]![0] !== closing[1]![0]) {
    return script
  }
  if (closing[1]!.length < opening[1]!.length) {
    return script
  }

  const newLine = script.includes("\r\n") ? "\r\n" : "\n"
  return lines.slice(firstNonEmpty + 1, lastNonEmpty).join(newLine)
}

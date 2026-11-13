/**
 * Display-only line breaks for model-generated scripts. A small scanner finds
 * statement boundaries, skipping literals and comments, so no parser is
 * needed. Scripts it cannot scan are returned unchanged.
 */

type Frame =
  | { readonly type: "block"; readonly start: number; readonly opener: string }
  | { readonly type: "brace" | "paren" | "bracket" | "template" | "subst" }

// Tokens after which `{` opens a statement block rather than an expression.
const blockOpeners = new Set([
  "",
  ";",
  "{",
  "}",
  ")",
  "=>",
  "else",
  "try",
  "finally",
  "do",
])

// Tokens after which `/` starts a regular expression rather than a division.
const regexKeywords = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
])

// Words that continue the statement a block belongs to.
const continuations = new Set([
  "else",
  "catch",
  "finally",
  "instanceof",
  "in",
  "as",
  "satisfies",
])

const isWord = (char: string) => /[\w$]/.test(char) || char.charCodeAt(0) > 127

const isSpace = (char: string) => /\s/.test(char)

// `prev` is "" at the start, a punctuator, a word, "id" for a property name,
// or "str" for a literal. After ")" a slash is not decided here: see below.
const regexAllowed = (prev: string) =>
  prev === "" ||
  regexKeywords.has(prev) ||
  (!isWord(prev[0]!) && !["]", "}o", "++", "--"].includes(prev))

/** Returns the positions of statement boundaries, or undefined if the script cannot be scanned. */
const findBreaks = (script: string): Set<number> | undefined => {
  const breaks = new Set<number>()
  const stack: Array<Frame> = []
  // Inside a template literal, including its substitutions, nothing is broken.
  let opaque = 0
  let prev = ""
  let prevEnd = 0
  const top = () => stack.at(-1)?.type
  const inStatements = () => {
    const type = top()
    return type === undefined || type === "block" || type === "brace"
  }
  // Skips whitespace and comments, or returns undefined for an unterminated comment.
  const skipTrivia = (from: number): number | undefined => {
    let i = from
    while (i < script.length) {
      if (isSpace(script[i]!)) i++
      else if (script.startsWith("//", i)) {
        const end = script.indexOf("\n", i)
        i = end === -1 ? script.length : end
      } else if (script.startsWith("/*", i)) {
        const end = script.indexOf("*/", i + 2)
        if (end === -1) return undefined
        i = end + 2
      } else break
    }
    return i
  }
  const nextToken = (from: number): string => {
    const i = skipTrivia(from)
    if (i === undefined || i >= script.length) return ""
    if (!isWord(script[i]!)) return script[i]!
    let end = i
    while (end < script.length && isWord(script[end]!)) end++
    return script.slice(i, end)
  }

  let i = 0
  while (i < script.length) {
    const char = script[i]!
    if (top() === "template") {
      if (char === "\\") i += 2
      else if (char === "`") {
        stack.pop()
        opaque--
        prev = "str"
        prevEnd = ++i
      } else if (script.startsWith("${", i)) {
        stack.push({ type: "subst" })
        prev = "("
        i += 2
      } else i++
      continue
    }
    if (
      isSpace(char) ||
      script.startsWith("//", i) ||
      script.startsWith("/*", i)
    ) {
      const end = skipTrivia(i)
      if (end === undefined) return undefined
      i = end
      continue
    }
    const start = i
    if (char === '"' || char === "'") {
      i++
      while (script[i] !== char) {
        if (i >= script.length || script[i] === "\n") return undefined
        i += script[i] === "\\" ? 2 : 1
      }
      i++
      prev = "str"
    } else if (char === "`") {
      stack.push({ type: "template" })
      opaque++
      i++
      continue
    } else if (char === "/" && prev === ")") {
      // After a control header such as `if (x)` it starts a regex, after a
      // call or a parenthesized expression it divides. Telling these apart
      // needs a parser, so leave the script unchanged.
      return undefined
    } else if (char === "/" && regexAllowed(prev)) {
      let inClass = false
      i++
      while (inClass || script[i] !== "/") {
        if (i >= script.length || script[i] === "\n") return undefined
        if (script[i] === "[") inClass = true
        else if (script[i] === "]") inClass = false
        i += script[i] === "\\" ? 2 : 1
      }
      i++
      while (i < script.length && isWord(script[i]!)) i++
      prev = "str"
    } else if (isWord(char)) {
      while (i < script.length && isWord(script[i]!)) i++
      // A name after "." is a property, even when it is spelled like a keyword.
      prev = prev === "." ? "id" : script.slice(start, i)
    } else if (char === "{") {
      if (blockOpeners.has(prev)) {
        stack.push({ type: "block", start: i, opener: prev })
        if (opaque === 0) breaks.add(i + 1)
      } else {
        stack.push({ type: "brace" })
      }
      prev = "{"
      i++
    } else if (char === "}") {
      const frame = stack.pop()
      if (
        frame === undefined ||
        !["block", "brace", "subst"].includes(frame.type)
      ) {
        return undefined
      }
      i++
      if (frame.type === "subst") continue
      prev = "}o"
      if (frame.type === "block") {
        prev = "}"
        if (opaque === 0) {
          // End the block's last statement, then the statement the block ends.
          if (prevEnd > frame.start + 1) breaks.add(prevEnd)
          const next = nextToken(i)
          if (
            inStatements() &&
            frame.opener !== "do" &&
            (next === "" ||
              next === "{" ||
              next === '"' ||
              next === "'" ||
              (isWord(next[0]!) && !continuations.has(next)))
          ) {
            breaks.add(i)
          }
        }
      }
    } else if (char === "(" || char === "[") {
      stack.push({ type: char === "(" ? "paren" : "bracket" })
      prev = char
      i++
    } else if (char === ")" || char === "]") {
      if (top() !== (char === ")" ? "paren" : "bracket")) return undefined
      stack.pop()
      prev = char
      i++
    } else if (char === ";") {
      if (opaque === 0 && inStatements()) breaks.add(i + 1)
      prev = char
      i++
    } else {
      const pair = script.slice(i, i + 2)
      prev = pair === "=>" || pair === "++" || pair === "--" ? pair : char
      i += prev.length
    }
    prevEnd = i
  }
  return stack.length === 0 ? breaks : undefined
}

/** Adds display-only line breaks, leaving execution and model history untouched. */
export const formatScript = (script: string): string => {
  const breaks = findBreaks(script)
  if (breaks === undefined) return script
  let output = ""
  let start = 0
  const newline = script.includes("\r\n") ? "\r\n" : "\n"
  for (const index of [...breaks].toSorted((a, b) => a - b)) {
    // Keep existing newlines / indentation, and avoid adding a trailing line.
    const rest = script.slice(index)
    if (/^[ \t]*(?:[\r\n]|$)/.test(rest)) continue
    output += script.slice(start, index) + newline
    start = index
    // Separators on the original line are not indentation for the new one.
    while (script[start] === " " || script[start] === "\t") start++
  }
  return output + script.slice(start)
}

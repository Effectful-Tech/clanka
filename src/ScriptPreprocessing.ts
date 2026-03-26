const callTemplateTargets = ["applyPatch", "taskComplete"] as const

const objectPropertyTargets = [
  { functionName: "writeFile", propertyName: "content" },
  { functionName: "updateTask", propertyName: "description" },
] as const

const isIdentifierChar = (char: string | undefined): boolean =>
  char !== undefined && /[A-Za-z0-9_$]/.test(char)

const isIdentifierStartChar = (char: string | undefined): boolean =>
  char !== undefined && /[A-Za-z_$]/.test(char)

const hasIdentifierBoundary = (
  text: string,
  index: number,
  length: number,
): boolean =>
  !isIdentifierChar(text[index - 1]) && !isIdentifierChar(text[index + length])

const findNextIdentifier = (
  text: string,
  identifier: string,
  from: number,
): number => {
  let index = text.indexOf(identifier, from)
  while (index !== -1) {
    if (hasIdentifierBoundary(text, index, identifier.length)) {
      return index
    }
    index = text.indexOf(identifier, index + identifier.length)
  }
  return -1
}

const skipWhitespace = (text: string, start: number): number => {
  let index = start
  while (index < text.length && /\s/.test(text[index]!)) {
    index++
  }
  return index
}

const parseIdentifier = (
  text: string,
  start: number,
): { readonly name: string; readonly end: number } | undefined => {
  if (!isIdentifierStartChar(text[start])) {
    return undefined
  }

  let end = start + 1
  while (end < text.length && isIdentifierChar(text[end])) {
    end++
  }

  return {
    name: text.slice(start, end),
    end,
  }
}

const findPreviousNonWhitespace = (text: string, from: number): number => {
  let index = from
  while (index >= 0 && /\s/.test(text[index]!)) {
    index--
  }
  return index
}

const findNextNonWhitespace = (text: string, from: number): number => {
  let index = from
  while (index < text.length && /\s/.test(text[index]!)) {
    index++
  }
  return index
}

const isEscaped = (text: string, index: number): boolean => {
  let slashCount = 0
  let cursor = index - 1
  while (cursor >= 0 && text[cursor] === "\\") {
    slashCount++
    cursor--
  }
  return slashCount % 2 === 1
}

const needsTemplateEscaping = (text: string): boolean => {
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (char === "`" && !isEscaped(text, index)) {
      return true
    }
    if (char === "$" && text[index + 1] === "{" && !isEscaped(text, index)) {
      return true
    }
  }
  return false
}

const findTemplateEnd = (
  text: string,
  start: number,
  isTerminator: (char: string | undefined) => boolean,
): number => {
  let end = -1
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] !== "`" || isEscaped(text, index)) {
      continue
    }

    if (isTerminator(text[index + 1])) {
      end = index
      continue
    }

    const next = skipWhitespace(text, index + 1)
    if (isTerminator(text[next])) {
      end = index
    }
  }
  return end
}

const findTemplateEndFirst = (
  text: string,
  start: number,
  isTerminator: (char: string | undefined) => boolean,
): number => {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] !== "`" || isEscaped(text, index)) {
      continue
    }

    if (isTerminator(text[index + 1])) {
      return index
    }

    const next = skipWhitespace(text, index + 1)
    if (isTerminator(text[next])) {
      return index
    }
  }

  return -1
}

const findTypeAnnotationAssignment = (text: string, start: number): number => {
  let index = start
  while (index < text.length) {
    const char = text[index]!
    if (char === "=") {
      return index
    }
    if (char === "\n" || char === ";") {
      return -1
    }
    index++
  }
  return -1
}

const findClosingParen = (text: string, openParen: number): number => {
  let depth = 1
  for (let index = openParen + 1; index < text.length; index++) {
    const char = text[index]!
    if (char === "(") {
      depth++
      continue
    }
    if (char === ")") {
      depth--
      if (depth === 0) {
        return index
      }
    }
  }
  return -1
}

const findClosingBrace = (text: string, openBrace: number): number => {
  let depth = 1
  let stringDelimiter: '"' | "'" | "`" | undefined

  for (let index = openBrace + 1; index < text.length; index++) {
    const char = text[index]!

    if (stringDelimiter !== undefined) {
      if (char === stringDelimiter && !isEscaped(text, index)) {
        stringDelimiter = undefined
      }
      continue
    }

    if (char === '"' || char === "'" || char === "`") {
      stringDelimiter = char
      continue
    }

    if (char === "{") {
      depth++
      continue
    }

    if (char === "}") {
      depth--
      if (depth === 0) {
        return index
      }
    }
  }

  return -1
}

const findObjectValueTerminator = (text: string, start: number): number => {
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let stringDelimiter: '"' | "'" | "`" | undefined

  for (let index = start; index < text.length; index++) {
    const char = text[index]!

    if (stringDelimiter !== undefined) {
      if (char === stringDelimiter && !isEscaped(text, index)) {
        stringDelimiter = undefined
      }
      continue
    }

    if (char === '"' || char === "'" || char === "`") {
      stringDelimiter = char
      continue
    }

    if (char === "(") {
      parenDepth++
      continue
    }
    if (char === ")") {
      if (parenDepth > 0) {
        parenDepth--
      }
      continue
    }
    if (char === "[") {
      bracketDepth++
      continue
    }
    if (char === "]") {
      if (bracketDepth > 0) {
        bracketDepth--
      }
      continue
    }
    if (char === "{") {
      braceDepth++
      continue
    }
    if (char === "}") {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        return index
      }
      if (braceDepth > 0) {
        braceDepth--
      }
      continue
    }

    if (
      char === "," &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      return index
    }
  }

  return -1
}

const collectExpressionIdentifiers = (
  text: string,
  start: number,
  end: number,
): ReadonlySet<string> => {
  const identifiers = new Set<string>()
  let cursor = start

  while (cursor < end) {
    const identifier = parseIdentifier(text, cursor)
    if (identifier === undefined) {
      cursor++
      continue
    }

    const previous = findPreviousNonWhitespace(text, cursor - 1)
    const next = findNextNonWhitespace(text, identifier.end)
    if (text[previous] !== "." && text[next] !== "." && text[next] !== "(") {
      identifiers.add(identifier.name)
    }

    cursor = identifier.end
  }

  return identifiers
}

const normalizePatchEscapedQuotes = (text: string): string =>
  text.includes("*** Begin Patch")
    ? text.replace(/\\"([A-Za-z0-9_$.-]+)\\"/g, (match, content, index) => {
        const previous = text[findPreviousNonWhitespace(text, index - 1)]
        const next = text[findNextNonWhitespace(text, index + match.length)]
        if (
          previous === "{" ||
          previous === "[" ||
          previous === ":" ||
          previous === "," ||
          next === ":" ||
          next === "}" ||
          next === "]" ||
          next === ","
        ) {
          return match
        }

        return `"${content}"`
      })
    : text

const normalizeNonPatchEscapedTemplateMarkers = (text: string): string =>
  text
    .replace(/\\{2,}(?=`|\$\{)/g, "\\")
    .replace(/(^|\s)\\+(?=\.[A-Za-z0-9_-]+\/)/g, "$1")

const findStringLiteralEnd = (
  text: string,
  start: number,
  delimiter: '"' | "'",
): number => {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === delimiter && !isEscaped(text, index)) {
      return index
    }
  }
  return -1
}

const findEnclosingStringLiteral = (
  text: string,
  index: number,
):
  | {
      readonly start: number
      readonly end: number
    }
  | undefined => {
  let start = index - 1
  while (start >= 0) {
    const char = text[start]!
    if ((char === '"' || char === "'") && !isEscaped(text, start)) {
      break
    }
    if (char === "\n" || char === "\r") {
      return undefined
    }
    start--
  }

  if (start < 0) {
    return undefined
  }

  const end = findStringLiteralEnd(text, start, text[start] as '"' | "'")
  if (end === -1 || index >= end) {
    return undefined
  }

  return { start, end }
}

const isControlEscapeCharacter = (char: string | undefined): boolean =>
  char !== undefined && /[0bnrtvf]/.test(char)

const isStringLiteralControlEscape = (
  text: string,
  index: number,
  nextChar: string | undefined,
): boolean =>
  isControlEscapeCharacter(nextChar) &&
  findEnclosingStringLiteral(text, index) !== undefined

const findInterpolationExpressionEnd = (
  text: string,
  openBrace: number,
): number => {
  let depth = 1
  let cursor = openBrace + 1

  while (cursor < text.length) {
    const char = text[cursor]!

    if (char === '"' || char === "'") {
      const stringEnd = findStringLiteralEnd(text, cursor, char)
      if (stringEnd === -1) {
        return -1
      }
      cursor = stringEnd + 1
      continue
    }

    if (char === "`") {
      const templateEnd = findTemplateLiteralEnd(text, cursor)
      if (templateEnd === -1) {
        return -1
      }
      cursor = templateEnd + 1
      continue
    }

    if (char === "{") {
      depth++
      cursor++
      continue
    }

    if (char === "}") {
      depth--
      if (depth === 0) {
        return cursor
      }
      cursor++
      continue
    }

    cursor++
  }

  return -1
}

const findTemplateLiteralEnd = (text: string, start: number): number => {
  let cursor = start + 1

  while (cursor < text.length) {
    const char = text[cursor]!

    if (char === "`" && !isEscaped(text, cursor)) {
      return cursor
    }

    if (char === "$" && text[cursor + 1] === "{" && !isEscaped(text, cursor)) {
      const interpolationEnd = findInterpolationExpressionEnd(text, cursor + 1)
      if (interpolationEnd === -1) {
        return -1
      }
      cursor = interpolationEnd + 1
      continue
    }

    cursor++
  }

  return -1
}

const findLiteralInterpolationEnd = (text: string, start: number): number => {
  const expressionStart = skipWhitespace(text, start + 2)
  const delimiter = text[expressionStart]
  if (delimiter !== '"' && delimiter !== "'" && delimiter !== "`") {
    return -1
  }

  const literalEnd =
    delimiter === "`"
      ? findTemplateLiteralEnd(text, expressionStart)
      : findStringLiteralEnd(text, expressionStart, delimiter)
  if (literalEnd === -1) {
    return -1
  }

  const expressionEnd = skipWhitespace(text, literalEnd + 1)
  return text[expressionEnd] === "}" ? expressionEnd : -1
}
const escapeTemplateLiteralContent = (text: string): string => {
  const patchNormalized = normalizePatchEscapedQuotes(text)
  const isPatchContent = patchNormalized.includes("*** Begin Patch")
  const normalized = isPatchContent
    ? patchNormalized
    : normalizeNonPatchEscapedTemplateMarkers(patchNormalized)

  if (
    !needsTemplateEscaping(normalized) &&
    !(isPatchContent && normalized.includes('\\"'))
  ) {
    return normalized
  }

  let out = ""
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index]!

    if (char === "\\") {
      let runEnd = index + 1
      while (normalized[runEnd] === "\\") {
        runEnd++
      }

      const runLength = runEnd - index
      const preservesTemplateMarker =
        normalized[runEnd] === "`" ||
        (normalized[runEnd] === "$" && normalized[runEnd + 1] === "{")
      if (preservesTemplateMarker) {
        out +=
          "\\".repeat(runLength + (runLength % 2 === 0 ? 1 : 0)) +
          normalized[runEnd]!
        index = runEnd
        continue
      }

      const escapedRunLength =
        runLength % 2 === 0 &&
        isStringLiteralControlEscape(normalized, index, normalized[runEnd])
          ? runLength
          : runLength * 2

      out += "\\".repeat(escapedRunLength)
      index = runEnd - 1
      continue
    }

    if (char === "`" && !isEscaped(normalized, index)) {
      out += "\\`"
      continue
    }

    if (
      char === "$" &&
      normalized[index + 1] === "{" &&
      !isEscaped(normalized, index)
    ) {
      const literalInterpolationEnd = findLiteralInterpolationEnd(
        normalized,
        index,
      )
      if (literalInterpolationEnd !== -1) {
        out += normalized.slice(index, literalInterpolationEnd + 1)
        index = literalInterpolationEnd
        continue
      }

      out += "\\$"
      continue
    }

    out += char
  }

  return out
}

const normalizeObjectLiteralTemplateMarkers = (text: string): string =>
  text.replace(/\\{2,}(?=`|\$\{)/g, "\\")

const escapeTaggedTemplateLiteralContent = (text: string): string => {
  if (!needsTemplateEscaping(text)) {
    return text
  }

  let out = ""
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (char === "`" && !isEscaped(text, index)) {
      out += "\\`"
      continue
    }
    if (char === "$" && text[index + 1] === "{" && !isEscaped(text, index)) {
      out += "\\$"
      continue
    }
    out += char
  }

  return out
}

const replaceSlice = (
  text: string,
  start: number,
  end: number,
  replacement: string,
): string => `${text.slice(0, start)}${replacement}${text.slice(end)}`

const rewriteTemplateContents = (
  script: string,
  findNext: (
    text: string,
    from: number,
  ) =>
    | {
        readonly contentStart: number
        readonly contentEnd: number
        readonly nextCursor: number
      }
    | undefined,
  rewrite: (content: string) => string,
): string => {
  let out = script
  let cursor = 0

  while (cursor < out.length) {
    const range = findNext(out, cursor)
    if (range === undefined) {
      break
    }

    const original = out.slice(range.contentStart, range.contentEnd)
    const updated = rewrite(original)
    if (updated !== original) {
      out = replaceSlice(out, range.contentStart, range.contentEnd, updated)
      cursor = range.nextCursor + (updated.length - original.length)
      continue
    }

    cursor = range.nextCursor
  }

  return out
}

const findDirectCallTemplate = (
  text: string,
  functionName: string,
  from: number,
):
  | {
      readonly contentStart: number
      readonly contentEnd: number
      readonly nextCursor: number
    }
  | undefined => {
  let cursor = from

  while (cursor < text.length) {
    const callStart = findNextIdentifier(text, functionName, cursor)
    if (callStart === -1) {
      return undefined
    }

    const openParen = skipWhitespace(text, callStart + functionName.length)
    if (text[openParen] !== "(") {
      cursor = callStart + functionName.length
      continue
    }

    const templateStart = skipWhitespace(text, openParen + 1)
    if (text[templateStart] !== "`") {
      cursor = openParen + 1
      continue
    }

    const closeParen = findClosingParen(text, openParen)
    let templateEnd = -1
    if (closeParen !== -1) {
      for (let index = closeParen - 1; index > templateStart; index--) {
        if (text[index] !== "`" || isEscaped(text, index)) {
          continue
        }

        const candidate = skipWhitespace(text, index + 1)
        if (candidate === closeParen || text[candidate] === ")") {
          templateEnd = index
          break
        }
      }
    }

    if (templateEnd === -1) {
      templateEnd = findTemplateEnd(text, templateStart, (char) => char === ")")
    }
    if (templateEnd === -1) {
      cursor = templateStart + 1
      continue
    }

    return {
      contentStart: templateStart + 1,
      contentEnd: templateEnd,
      nextCursor: templateEnd + 1,
    }
  }

  return undefined
}

const findObjectPropertyTemplate = (
  text: string,
  target: (typeof objectPropertyTargets)[number],
  from: number,
):
  | {
      readonly contentStart: number
      readonly contentEnd: number
      readonly nextCursor: number
    }
  | undefined => {
  let cursor = from

  while (cursor < text.length) {
    const callStart = findNextIdentifier(text, target.functionName, cursor)
    if (callStart === -1) {
      return undefined
    }

    const openParen = skipWhitespace(
      text,
      callStart + target.functionName.length,
    )
    if (text[openParen] !== "(") {
      cursor = callStart + target.functionName.length
      continue
    }

    const propertyKey = findNextIdentifier(
      text,
      target.propertyName,
      openParen + 1,
    )
    if (propertyKey === -1) {
      cursor = openParen + 1
      continue
    }

    const colon = skipWhitespace(text, propertyKey + target.propertyName.length)
    if (text[colon] !== ":") {
      cursor = propertyKey + target.propertyName.length
      continue
    }

    const templateStart = skipWhitespace(text, colon + 1)
    if (text[templateStart] !== "`") {
      cursor = templateStart + 1
      continue
    }

    const templateEnd = findTemplateEnd(
      text,
      templateStart,
      (char) => char === "}" || char === ",",
    )
    if (templateEnd === -1) {
      cursor = templateStart + 1
      continue
    }

    return {
      contentStart: templateStart + 1,
      contentEnd: templateEnd,
      nextCursor: templateEnd + 1,
    }
  }

  return undefined
}

const findTaggedTemplate = (
  text: string,
  tag: string,
  from: number,
):
  | {
      readonly contentStart: number
      readonly contentEnd: number
      readonly nextCursor: number
    }
  | undefined => {
  let cursor = from

  while (cursor < text.length) {
    const tagStart = findNextIdentifier(text, tag, cursor)
    if (tagStart === -1) {
      return undefined
    }

    const templateStart = skipWhitespace(text, tagStart + tag.length)
    if (text[templateStart] !== "`") {
      cursor = tagStart + tag.length
      continue
    }

    const templateEnd = findTemplateEndFirst(
      text,
      templateStart,
      (char) =>
        char === undefined ||
        char === "+" ||
        char === "," ||
        char === ";" ||
        char === ")" ||
        char === "}" ||
        char === "]",
    )
    if (templateEnd === -1) {
      cursor = templateStart + 1
      continue
    }

    return {
      contentStart: templateStart + 1,
      contentEnd: templateEnd,
      nextCursor: templateEnd + 1,
    }
  }

  return undefined
}

const collectCallArgumentIdentifiers = (
  script: string,
  functionName: string,
): ReadonlySet<string> => {
  const identifiers = new Set<string>()
  let cursor = 0

  while (cursor < script.length) {
    const callStart = findNextIdentifier(script, functionName, cursor)
    if (callStart === -1) {
      break
    }

    const openParen = skipWhitespace(script, callStart + functionName.length)
    if (script[openParen] !== "(") {
      cursor = callStart + functionName.length
      continue
    }

    const argumentStart = skipWhitespace(script, openParen + 1)
    const identifier = parseIdentifier(script, argumentStart)
    if (identifier === undefined) {
      cursor = openParen + 1
      continue
    }

    const argumentEnd = skipWhitespace(script, identifier.end)
    if (script[argumentEnd] === ")" || script[argumentEnd] === ",") {
      identifiers.add(identifier.name)
    }

    cursor = identifier.end
  }

  return identifiers
}

const collectObjectPropertyIdentifiers = (
  script: string,
  target: (typeof objectPropertyTargets)[number],
): ReadonlySet<string> => {
  const identifiers = new Set<string>()
  let cursor = 0

  while (cursor < script.length) {
    const callStart = findNextIdentifier(script, target.functionName, cursor)
    if (callStart === -1) {
      break
    }

    const openParen = skipWhitespace(
      script,
      callStart + target.functionName.length,
    )
    if (script[openParen] !== "(") {
      cursor = callStart + target.functionName.length
      continue
    }

    const propertyKey = findNextIdentifier(
      script,
      target.propertyName,
      openParen + 1,
    )
    if (propertyKey === -1) {
      cursor = openParen + 1
      continue
    }

    const afterProperty = skipWhitespace(
      script,
      propertyKey + target.propertyName.length,
    )
    if (script[afterProperty] === ":") {
      const valueStart = skipWhitespace(script, afterProperty + 1)
      const valueEnd = findObjectValueTerminator(script, valueStart)
      if (valueEnd !== -1) {
        for (const identifier of collectExpressionIdentifiers(
          script,
          valueStart,
          valueEnd,
        )) {
          identifiers.add(identifier)
        }
      }
      cursor = valueStart + 1
      continue
    }

    if (script[afterProperty] === "}" || script[afterProperty] === ",") {
      identifiers.add(target.propertyName)
      cursor = afterProperty + 1
      continue
    }

    cursor = afterProperty + 1
  }

  return identifiers
}

const rewriteAssignedTemplate = (
  script: string,
  variableName: string,
): string =>
  rewriteTemplateContents(
    script,
    (text, from) => {
      let cursor = from

      while (cursor < text.length) {
        const variableStart = findNextIdentifier(text, variableName, cursor)
        if (variableStart === -1) {
          return undefined
        }

        let assignmentStart = skipWhitespace(
          text,
          variableStart + variableName.length,
        )
        if (text[assignmentStart] === ":") {
          assignmentStart = findTypeAnnotationAssignment(
            text,
            assignmentStart + 1,
          )
          if (assignmentStart === -1) {
            cursor = variableStart + variableName.length
            continue
          }
        }

        if (
          text[assignmentStart] !== "=" ||
          text[assignmentStart + 1] === "=" ||
          text[assignmentStart + 1] === ">"
        ) {
          cursor = variableStart + variableName.length
          continue
        }

        const templateStart = skipWhitespace(text, assignmentStart + 1)
        if (text[templateStart] !== "`") {
          cursor = templateStart + 1
          continue
        }

        const templateEnd = findTemplateEnd(
          text,
          templateStart,
          (char) =>
            char === undefined ||
            char === "\n" ||
            char === "\r" ||
            char === ";" ||
            char === "," ||
            char === ")" ||
            char === "}" ||
            char === "]",
        )
        if (templateEnd === -1) {
          cursor = templateStart + 1
          continue
        }

        return {
          contentStart: templateStart + 1,
          contentEnd: templateEnd,
          nextCursor: templateEnd + 1,
        }
      }

      return undefined
    },
    escapeTemplateLiteralContent,
  )

const rewriteAssignedObjectLiteral = (
  script: string,
  variableName: string,
): string => {
  let out = script
  let cursor = 0

  while (cursor < out.length) {
    const variableStart = findNextIdentifier(out, variableName, cursor)
    if (variableStart === -1) {
      break
    }

    let assignmentStart = skipWhitespace(
      out,
      variableStart + variableName.length,
    )
    if (out[assignmentStart] === ":") {
      assignmentStart = findTypeAnnotationAssignment(out, assignmentStart + 1)
      if (assignmentStart === -1) {
        cursor = variableStart + variableName.length
        continue
      }
    }

    if (
      out[assignmentStart] !== "=" ||
      out[assignmentStart + 1] === "=" ||
      out[assignmentStart + 1] === ">"
    ) {
      cursor = variableStart + variableName.length
      continue
    }

    const objectStart = skipWhitespace(out, assignmentStart + 1)
    if (out[objectStart] !== "{") {
      cursor = objectStart + 1
      continue
    }

    const objectEnd = findClosingBrace(out, objectStart)
    if (objectEnd === -1) {
      cursor = objectStart + 1
      continue
    }

    const original = out.slice(objectStart, objectEnd + 1)
    const updated = normalizeObjectLiteralTemplateMarkers(original)
    if (updated !== original) {
      out = replaceSlice(out, objectStart, objectEnd + 1, updated)
      cursor = objectEnd + 1 + (updated.length - original.length)
      continue
    }

    cursor = objectEnd + 1
  }

  return out
}

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")

const collectObjectEntryMapSources = (
  script: string,
  valueIdentifier: string,
): ReadonlySet<string> => {
  const identifiers = new Set<string>()
  const pattern = new RegExp(
    `Object\\.entries\\(\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\)\\s*\\.map\\(\\s*(?:async\\s*)?\\(\\s*\\[\\s*[A-Za-z_$][A-Za-z0-9_$]*\\s*,\\s*${escapeRegExp(valueIdentifier)}\\s*\\]\\s*\\)\\s*=>`,
    "g",
  )

  for (const match of script.matchAll(pattern)) {
    if (match[1] !== undefined) {
      identifiers.add(match[1])
    }
  }

  return identifiers
}

const rewriteDirectTemplates = (script: string): string => {
  let out = script

  out = rewriteTemplateContents(
    out,
    (text, from) => findTaggedTemplate(text, "String.raw", from),
    escapeTaggedTemplateLiteralContent,
  )

  for (const target of objectPropertyTargets) {
    out = rewriteTemplateContents(
      out,
      (text, from) => findObjectPropertyTemplate(text, target, from),
      escapeTemplateLiteralContent,
    )
  }

  for (const functionName of callTemplateTargets) {
    out = rewriteTemplateContents(
      out,
      (text, from) => findDirectCallTemplate(text, functionName, from),
      escapeTemplateLiteralContent,
    )
  }

  return out
}

const collectReferencedTemplateIdentifiers = (
  script: string,
): {
  readonly templateIdentifiers: ReadonlySet<string>
  readonly objectIdentifiers: ReadonlySet<string>
} => {
  const templateIdentifiers = new Set<string>()

  for (const functionName of callTemplateTargets) {
    for (const identifier of collectCallArgumentIdentifiers(
      script,
      functionName,
    )) {
      templateIdentifiers.add(identifier)
    }
  }

  for (const target of objectPropertyTargets) {
    for (const identifier of collectObjectPropertyIdentifiers(script, target)) {
      templateIdentifiers.add(identifier)
    }
  }

  if (script.includes("*** Begin Patch")) {
    templateIdentifiers.add("patch")
  }

  const objectIdentifiers = new Set<string>()
  for (const identifier of templateIdentifiers) {
    for (const source of collectObjectEntryMapSources(script, identifier)) {
      objectIdentifiers.add(source)
    }
  }

  return {
    templateIdentifiers,
    objectIdentifiers,
  }
}

const rewriteAssignedTargets = (script: string): string => {
  const { templateIdentifiers, objectIdentifiers } =
    collectReferencedTemplateIdentifiers(script)

  let out = script
  for (const identifier of templateIdentifiers) {
    out = rewriteAssignedTemplate(out, identifier)
  }
  for (const identifier of objectIdentifiers) {
    out = rewriteAssignedObjectLiteral(out, identifier)
  }

  return out
}

export const preprocessScript = (script: string): string =>
  rewriteAssignedTargets(rewriteDirectTemplates(script))

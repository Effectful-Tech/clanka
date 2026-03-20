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
  let i = start
  while (i < text.length && /\s/.test(text[i]!)) {
    i++
  }
  return i
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
  let i = from
  while (i >= 0 && /\s/.test(text[i]!)) {
    i--
  }
  return i
}

const findNextNonWhitespace = (text: string, from: number): number => {
  let i = from
  while (i < text.length && /\s/.test(text[i]!)) {
    i++
  }
  return i
}

const findObjectValueTerminator = (text: string, start: number): number => {
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let stringDelimiter: '"' | "'" | "`" | undefined

  for (let i = start; i < text.length; i++) {
    const char = text[i]!

    if (stringDelimiter !== undefined) {
      if (char === stringDelimiter && !isEscaped(text, i)) {
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
        return i
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
      return i
    }
  }

  return -1
}

const collectExpressionIdentifiers = (
  text: string,
  start: number,
  end: number,
): ReadonlySet<string> => {
  const out = new Set<string>()
  let cursor = start

  while (cursor < end) {
    const identifier = parseIdentifier(text, cursor)
    if (identifier === undefined) {
      cursor++
      continue
    }

    const previousNonWhitespace = findPreviousNonWhitespace(text, cursor - 1)
    const nextNonWhitespace = findNextNonWhitespace(text, identifier.end)
    if (
      text[previousNonWhitespace] !== "." &&
      text[nextNonWhitespace] !== "." &&
      text[nextNonWhitespace] !== "("
    ) {
      out.add(identifier.name)
    }

    cursor = identifier.end
  }

  return out
}

const isEscaped = (text: string, index: number): boolean => {
  let slashCount = 0
  let i = index - 1
  while (i >= 0 && text[i] === "\\") {
    slashCount++
    i--
  }
  return slashCount % 2 === 1
}

const needsTemplateEscaping = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (char === "`" && !isEscaped(text, i)) {
      return true
    }
    if (char === "$" && text[i + 1] === "{" && !isEscaped(text, i)) {
      return true
    }
  }
  return false
}

const normalizePatchEscapedQuotes = (text: string): string =>
  text.includes("*** Begin Patch")
    ? text.replace(/\\"([A-Za-z0-9_$.-]+)\\"/g, '"$1"')
    : text

const normalizeNonPatchEscapedTemplateMarkers = (text: string): string =>
  text
    .replace(/\\{2,}(?=`|\$\{)/g, "\\")
    .replace(/(^|\s)\\+(?=\.[A-Za-z0-9_-]+\/)/g, "$1")

const escapeTemplateLiteralContent = (text: string): string => {
  const normalizedPatchQuotes = normalizePatchEscapedQuotes(text)
  const isPatchContent = normalizedPatchQuotes.includes("*** Begin Patch")
  const normalized = isPatchContent
    ? normalizedPatchQuotes
    : normalizeNonPatchEscapedTemplateMarkers(normalizedPatchQuotes)
  if (!needsTemplateEscaping(normalized)) {
    return normalized
  }

  let out = ""
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]!
    if (char === "\\") {
      if (
        !isPatchContent &&
        (normalized[i + 1] === "`" ||
          (normalized[i + 1] === "$" && normalized[i + 2] === "{"))
      ) {
        out += "\\"
        continue
      }
      out += "\\\\"
      continue
    }
    if (char === "`" && !isEscaped(normalized, i)) {
      out += "\\`"
      continue
    }
    if (
      char === "$" &&
      normalized[i + 1] === "{" &&
      !isEscaped(normalized, i)
    ) {
      out += "\\$"
      continue
    }
    out += char
  }
  return out
}

const findTemplateEnd = (
  text: string,
  start: number,
  isTerminator: (char: string | undefined) => boolean,
): number => {
  let end = -1
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] !== "`" || isEscaped(text, i)) {
      continue
    }
    const next = skipWhitespace(text, i + 1)
    if (isTerminator(text[next])) {
      end = i
    }
  }
  return end
}

const findTypeAnnotationAssignment = (text: string, start: number): number => {
  let i = start
  while (i < text.length) {
    const char = text[i]!
    if (char === "=") {
      return i
    }
    if (char === "\n" || char === ";") {
      return -1
    }
    i++
  }
  return -1
}

const findClosingParen = (text: string, openParen: number): number => {
  let depth = 1
  for (let i = openParen + 1; i < text.length; i++) {
    const char = text[i]!
    if (char === "(") {
      depth++
      continue
    }
    if (char === ")") {
      depth--
      if (depth === 0) {
        return i
      }
    }
  }
  return -1
}

const findCallTemplateEnd = (
  text: string,
  templateStart: number,
  openParen: number,
): number => {
  const closeParen = findClosingParen(text, openParen)
  if (closeParen === -1) {
    return -1
  }

  for (let i = closeParen - 1; i > templateStart; i--) {
    if (text[i] === "`" && !isEscaped(text, i)) {
      return i
    }
  }

  return -1
}

const fixCallTemplateArgument = (
  script: string,
  functionName: string,
): string => {
  let out = script
  let cursor = 0

  while (cursor < out.length) {
    const callStart = findNextIdentifier(out, functionName, cursor)
    if (callStart === -1) {
      break
    }

    const openParen = skipWhitespace(out, callStart + functionName.length)
    if (out[openParen] !== "(") {
      cursor = callStart + functionName.length
      continue
    }

    const templateStart = skipWhitespace(out, openParen + 1)
    if (out[templateStart] !== "`") {
      cursor = openParen + 1
      continue
    }

    const templateEnd = findCallTemplateEnd(out, templateStart, openParen)
    if (templateEnd === -1) {
      cursor = templateStart + 1
      continue
    }

    const original = out.slice(templateStart + 1, templateEnd)
    const escaped = escapeTemplateLiteralContent(original)
    if (escaped !== original) {
      out = `${out.slice(0, templateStart + 1)}${escaped}${out.slice(templateEnd)}`
      cursor = templateEnd + (escaped.length - original.length) + 1
      continue
    }

    cursor = templateEnd + 1
  }

  return out
}

const fixCallObjectPropertyTemplate = (
  script: string,
  functionName: string,
  propertyName: string,
): string => {
  let out = script
  let cursor = 0

  while (cursor < out.length) {
    const callStart = findNextIdentifier(out, functionName, cursor)
    if (callStart === -1) {
      break
    }

    const openParen = skipWhitespace(out, callStart + functionName.length)
    if (out[openParen] !== "(") {
      cursor = callStart + functionName.length
      continue
    }

    const propertyKey = findNextIdentifier(out, propertyName, openParen + 1)
    if (propertyKey === -1) {
      cursor = openParen + 1
      continue
    }

    const colon = skipWhitespace(out, propertyKey + propertyName.length)
    if (out[colon] !== ":") {
      cursor = propertyKey + propertyName.length
      continue
    }

    const templateStart = skipWhitespace(out, colon + 1)
    if (out[templateStart] !== "`") {
      cursor = templateStart + 1
      continue
    }

    const templateEnd = findTemplateEnd(
      out,
      templateStart,
      (char) => char === "}" || char === ",",
    )
    if (templateEnd === -1) {
      cursor = templateStart + 1
      continue
    }

    const original = out.slice(templateStart + 1, templateEnd)
    const escaped = escapeTemplateLiteralContent(original)
    if (escaped !== original) {
      out = `${out.slice(0, templateStart + 1)}${escaped}${out.slice(templateEnd)}`
      cursor = templateEnd + (escaped.length - original.length) + 1
      continue
    }

    cursor = templateEnd + 1
  }

  return out
}

const collectCallArgumentIdentifiers = (
  script: string,
  functionName: string,
): ReadonlySet<string> => {
  const out = new Set<string>()
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
      out.add(identifier.name)
    }

    cursor = identifier.end
  }

  return out
}

const collectCallObjectPropertyIdentifiers = (
  script: string,
  functionName: string,
  propertyName: string,
): ReadonlySet<string> => {
  const out = new Set<string>()
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

    const propertyKey = findNextIdentifier(script, propertyName, openParen + 1)
    if (propertyKey === -1) {
      cursor = openParen + 1
      continue
    }

    const afterProperty = skipWhitespace(
      script,
      propertyKey + propertyName.length,
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
          out.add(identifier)
        }
      }
      cursor = valueStart + 1
      continue
    }

    if (script[afterProperty] === "}" || script[afterProperty] === ",") {
      out.add(propertyName)
      cursor = afterProperty + 1
      continue
    }

    cursor = afterProperty + 1
  }

  return out
}

const callObjectPropertyTargets = [
  ["writeFile", "content"],
  ["updateTask", "description"],
] as const

const fixTargetCallObjectPropertyTemplates = (script: string): string =>
  callObjectPropertyTargets.reduce(
    (current, [functionName, propertyName]) =>
      fixCallObjectPropertyTemplate(current, functionName, propertyName),
    script,
  )

const fixAssignedTemplate = (script: string, variableName: string): string => {
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

    const templateStart = skipWhitespace(out, assignmentStart + 1)
    if (out[templateStart] !== "`") {
      cursor = templateStart + 1
      continue
    }

    const templateEnd = findTemplateEnd(
      out,
      templateStart,
      (char) =>
        char === undefined ||
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

    const original = out.slice(templateStart + 1, templateEnd)
    const escaped = escapeTemplateLiteralContent(original)
    if (escaped !== original) {
      out = `${out.slice(0, templateStart + 1)}${escaped}${out.slice(templateEnd)}`
      cursor = templateEnd + (escaped.length - original.length) + 1
      continue
    }

    cursor = templateEnd + 1
  }

  return out
}

const fixAssignedTemplatesForToolCalls = (script: string): string => {
  const identifiers = new Set<string>()
  for (const functionName of ["applyPatch", "taskComplete"] as const) {
    for (const identifier of collectCallArgumentIdentifiers(
      script,
      functionName,
    )) {
      identifiers.add(identifier)
    }
  }
  for (const [functionName, propertyName] of callObjectPropertyTargets) {
    for (const identifier of collectCallObjectPropertyIdentifiers(
      script,
      functionName,
      propertyName,
    )) {
      identifiers.add(identifier)
    }
  }
  if (script.includes("*** Begin Patch")) {
    identifiers.add("patch")
  }

  let out = script
  for (const identifier of identifiers) {
    out = fixAssignedTemplate(out, identifier)
  }
  return out
}

export const preprocessScript = (script: string): string =>
  fixAssignedTemplatesForToolCalls(
    ["applyPatch", "taskComplete"].reduce(
      (current, functionName) => fixCallTemplateArgument(current, functionName),
      fixTargetCallObjectPropertyTemplates(script),
    ),
  )

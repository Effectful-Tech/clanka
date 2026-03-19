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

const escapeTemplateLiteralContent = (text: string): string => {
  if (!needsTemplateEscaping(text)) {
    return text
  }

  let out = ""
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (char === "\\") {
      out += "\\\\"
      continue
    }
    if (char === "`" && !isEscaped(text, i)) {
      out += "\\`"
      continue
    }
    if (char === "$" && text[i + 1] === "{" && !isEscaped(text, i)) {
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
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] !== "`" || isEscaped(text, i)) {
      continue
    }
    const next = skipWhitespace(text, i + 1)
    if (isTerminator(text[next])) {
      return i
    }
  }
  return -1
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

const fixCallTemplateArgument = (
  script: string,
  functionName: string,
  isTerminator: (char: string | undefined) => boolean,
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

    const templateEnd = findTemplateEnd(out, templateStart, isTerminator)
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

const fixWriteFileContentTemplates = (script: string): string => {
  let out = script
  let cursor = 0

  while (cursor < out.length) {
    const callStart = findNextIdentifier(out, "writeFile", cursor)
    if (callStart === -1) {
      break
    }

    const openParen = skipWhitespace(out, callStart + "writeFile".length)
    if (out[openParen] !== "(") {
      cursor = callStart + "writeFile".length
      continue
    }

    const contentKey = findNextIdentifier(out, "content", openParen + 1)
    if (contentKey === -1) {
      cursor = openParen + 1
      continue
    }

    const colon = skipWhitespace(out, contentKey + "content".length)
    if (out[colon] !== ":") {
      cursor = contentKey + "content".length
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

const collectWriteFileContentIdentifiers = (
  script: string,
): ReadonlySet<string> => {
  const out = new Set<string>()
  let cursor = 0

  while (cursor < script.length) {
    const callStart = findNextIdentifier(script, "writeFile", cursor)
    if (callStart === -1) {
      break
    }

    const openParen = skipWhitespace(script, callStart + "writeFile".length)
    if (script[openParen] !== "(") {
      cursor = callStart + "writeFile".length
      continue
    }

    const contentKey = findNextIdentifier(script, "content", openParen + 1)
    if (contentKey === -1) {
      cursor = openParen + 1
      continue
    }

    const afterContent = skipWhitespace(script, contentKey + "content".length)
    if (script[afterContent] === ":") {
      const valueStart = skipWhitespace(script, afterContent + 1)
      const identifier = parseIdentifier(script, valueStart)
      if (identifier !== undefined) {
        const valueEnd = skipWhitespace(script, identifier.end)
        if (script[valueEnd] === "}" || script[valueEnd] === ",") {
          out.add(identifier.name)
        }
      }
      cursor = valueStart + 1
      continue
    }

    if (script[afterContent] === "}" || script[afterContent] === ",") {
      out.add("content")
      cursor = afterContent + 1
      continue
    }

    cursor = afterContent + 1
  }

  return out
}

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
  for (const identifier of collectWriteFileContentIdentifiers(script)) {
    identifiers.add(identifier)
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
      (current, functionName) =>
        fixCallTemplateArgument(current, functionName, (char) => char === ")"),
      fixWriteFileContentTemplates(script),
    ),
  )

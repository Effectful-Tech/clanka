import { Schema, SchemaAST as AST } from "effect"

const resolveDocumentation = AST.resolveAt<string>("documentation")
const identifierPattern = /^[$A-Z_a-z][$0-9A-Z_a-z]*$/u

const Precedence = {
  Union: 0,
  Postfix: 1,
  Primary: 2,
} as const

type Precedence = (typeof Precedence)[keyof typeof Precedence]

export type PrinterOptions = {
  readonly newLine?: "\n" | "\r\n"
  readonly omitTrailingSemicolon?: boolean
}

export type PrintableNode = {
  readonly text: string
}

type RenderContext = {
  activeNodes: Set<AST.AST>
  options: Required<PrinterOptions>
}

type RenderedType = PrintableNode & {
  readonly precedence: Precedence
}

type TemplateLiteralSpan = {
  readonly type: string
  text: string
}

type TemplateLiteralState = {
  head: string
  currentText: string
  spans: Array<TemplateLiteralSpan>
}

const normalizeOptions = (
  options?: PrinterOptions,
): Required<PrinterOptions> => ({
  newLine: options?.newLine ?? "\n",
  omitTrailingSemicolon: options?.omitTrailingSemicolon ?? false,
})

const indent = (level: number): string => "    ".repeat(level)

const prefixFirstLine = (
  text: string,
  prefix: string,
  newLine: string,
): string => {
  const lines = text.split(newLine)
  const [firstLine, ...restLines] = lines

  return [prefix + (firstLine ?? ""), ...restLines].join(newLine)
}

const appendSuffix = (
  text: string,
  suffix: string,
  newLine: string,
): string => {
  if (suffix.length === 0) {
    return text
  }

  const lines = text.split(newLine)
  const lastIndex = lines.length - 1

  lines[lastIndex] = `${lines[lastIndex] ?? ""}${suffix}`

  return lines.join(newLine)
}

const renderJsDoc = (
  documentation: string,
  indentLevel: number,
  options: Required<PrinterOptions>,
): string => {
  const safeDocumentation = documentation.replaceAll("*/", "*\\/")
  const indentation = indent(indentLevel)
  const lines = safeDocumentation.split(/\r?\n/u)

  if (lines.length === 1) {
    return `${indentation}/** ${lines[0]} */`
  }

  return [
    `${indentation}/**`,
    ...lines.map((line) => `${indentation} * ${line}`),
    `${indentation} */`,
  ].join(options.newLine)
}

const parenthesize = (text: string): string => `(${text})`

const withParenthesesIfNeeded = (
  rendered: RenderedType,
  minimumPrecedence: Precedence,
): string =>
  rendered.precedence < minimumPrecedence
    ? parenthesize(rendered.text)
    : rendered.text

const unknownTypeNode = (): RenderedType => ({
  text: "unknown",
  precedence: Precedence.Primary,
})

const primitiveTypeNode = (keyword: string): RenderedType => ({
  text: keyword,
  precedence: Precedence.Primary,
})

const readonlyTypeNode = (rendered: RenderedType, context: RenderContext) => ({
  text: prefixFirstLine(rendered.text, "readonly ", context.options.newLine),
  precedence: Precedence.Primary,
})

const nullTypeNode = (): RenderedType => ({
  text: "null",
  precedence: Precedence.Primary,
})

const stringLiteralTypeNode = (value: string): RenderedType => ({
  text: JSON.stringify(value),
  precedence: Precedence.Primary,
})

const referenceTypeNode = (
  identifier: string,
  typeArguments?: ReadonlyArray<RenderedType>,
): RenderedType => ({
  text:
    typeArguments === undefined || typeArguments.length === 0
      ? identifier
      : `${identifier}<${typeArguments.map((type) => type.text).join(", ")}>`,
  precedence: Precedence.Primary,
})

const cycleTypeNode = (ast: AST.AST): RenderedType => {
  const visitedSuspends = new Set<AST.Suspend>()
  let current: AST.AST = ast

  while (true) {
    const identifier = AST.resolveIdentifier(current)

    if (identifier !== undefined) {
      return referenceTypeNode(identifier)
    }

    if (current._tag !== "Suspend" || visitedSuspends.has(current)) {
      return unknownTypeNode()
    }

    visitedSuspends.add(current)
    current = current.thunk()
  }
}

const literalText = (value: AST.Literal["literal"]): string => String(value)

const numberLiteralTypeNode = (value: number): RenderedType => ({
  text: Object.is(value, -0) || value < 0 ? `-${-value}` : `${value}`,
  precedence: Precedence.Primary,
})

const bigintLiteralTypeNode = (value: bigint): RenderedType => ({
  text: value < 0n ? `-${-value}n` : `${value}n`,
  precedence: Precedence.Primary,
})

const literalTypeNode = (ast: AST.Literal): RenderedType => {
  switch (typeof ast.literal) {
    case "string":
      return stringLiteralTypeNode(ast.literal)
    case "number":
      return numberLiteralTypeNode(ast.literal)
    case "boolean":
      return primitiveTypeNode(ast.literal ? "true" : "false")
    case "bigint":
      return bigintLiteralTypeNode(ast.literal)
  }
}

const unionOfTypeNodes = (types: ReadonlyArray<RenderedType>): RenderedType => {
  const [firstType, ...restTypes] = types

  if (firstType === undefined) {
    return primitiveTypeNode("never")
  }

  return {
    text:
      restTypes.length === 0
        ? firstType.text
        : types.map((type) => type.text).join(" | "),
    precedence:
      restTypes.length === 0 ? firstType.precedence : Precedence.Union,
  }
}

const uniqueSymbolTypeNode = (ast: AST.UniqueSymbol): RenderedType => {
  const description = ast.symbol.description

  return {
    text:
      description === undefined
        ? "unique symbol"
        : `typeof Symbol.for(${JSON.stringify(description)})`,
    precedence: Precedence.Primary,
  }
}

const symbolExpression = (symbol: symbol): string => {
  const description = symbol.description

  return description === undefined
    ? "Symbol()"
    : `Symbol.for(${JSON.stringify(description)})`
}

const propertyName = (name: PropertyKey): string => {
  switch (typeof name) {
    case "string":
      return identifierPattern.test(name) ? name : JSON.stringify(name)
    case "number":
      return `${name}`
    case "symbol":
      return `[${symbolExpression(name)}]`
  }
}

const rootDocumentation = (ast: AST.AST): string | undefined => {
  const visitedSuspends = new Set<AST.Suspend>()
  let current: AST.AST = ast

  while (true) {
    const documentation = resolveDocumentation(current)

    if (documentation !== undefined) {
      return documentation
    }

    if (current._tag !== "Suspend" || visitedSuspends.has(current)) {
      return undefined
    }

    visitedSuspends.add(current)
    current = current.thunk()
  }
}

const propertySignatureTypeElement = (
  propertySignature: AST.PropertySignature,
  context: RenderContext,
  indentLevel: number,
): string => {
  const readonlyModifier =
    propertySignature.type.context?.isMutable === true ? "" : "readonly "
  const optionalMarker = AST.isOptional(propertySignature.type) ? "?" : ""
  const propertyType = toTypeNode(propertySignature.type, context, indentLevel)
  const propertyText = prefixFirstLine(
    appendSuffix(
      propertyType.text,
      context.options.omitTrailingSemicolon ? "" : ";",
      context.options.newLine,
    ),
    `${indent(indentLevel)}${readonlyModifier}${propertyName(propertySignature.name)}${optionalMarker}: `,
    context.options.newLine,
  )
  const documentation = resolveDocumentation(propertySignature.type)

  return documentation === undefined
    ? propertyText
    : `${renderJsDoc(documentation, indentLevel, context.options)}${context.options.newLine}${propertyText}`
}

const indexSignatureTypeElement = (
  indexSignature: AST.IndexSignature,
  context: RenderContext,
  indentLevel: number,
): string => {
  const parameterType = toTypeNode(
    indexSignature.parameter,
    context,
    indentLevel,
  )
  const valueType = toTypeNode(indexSignature.type, context, indentLevel)

  return prefixFirstLine(
    appendSuffix(
      valueType.text,
      context.options.omitTrailingSemicolon ? "" : ";",
      context.options.newLine,
    ),
    `${indent(indentLevel)}[x: ${parameterType.text}]: `,
    context.options.newLine,
  )
}

const objectsTypeNode = (
  ast: AST.Objects,
  context: RenderContext,
  indentLevel: number,
): RenderedType => {
  const members = [
    ...ast.propertySignatures.map((propertySignature) =>
      propertySignatureTypeElement(propertySignature, context, indentLevel + 1),
    ),
    ...ast.indexSignatures.map((indexSignature) =>
      indexSignatureTypeElement(indexSignature, context, indentLevel + 1),
    ),
  ]

  return {
    text:
      members.length === 0
        ? "{}"
        : ["{", ...members, `${indent(indentLevel)}}`].join(
            context.options.newLine,
          ),
    precedence: Precedence.Primary,
  }
}

const unionTypeNode = (
  ast: AST.Union,
  context: RenderContext,
  indentLevel: number,
): RenderedType =>
  unionOfTypeNodes(
    ast.types.map((type) => toTypeNode(type, context, indentLevel)),
  )

const enumTypeNode = (ast: AST.Enum): RenderedType =>
  unionOfTypeNodes(
    ast.enums.map(([, value]) =>
      typeof value === "string"
        ? stringLiteralTypeNode(value)
        : numberLiteralTypeNode(value),
    ),
  )

const pushTemplateLiteralInterpolation = (
  state: TemplateLiteralState,
  type: string,
): void => {
  const lastSpan = state.spans[state.spans.length - 1]

  if (lastSpan === undefined) {
    state.head = state.currentText
  } else {
    lastSpan.text = state.currentText
  }

  state.spans.push({ type, text: "" })
  state.currentText = ""
}

const visitTemplateLiteralPart = (
  state: TemplateLiteralState,
  ast: AST.AST,
  context: RenderContext,
  indentLevel: number,
): void => {
  switch (ast._tag) {
    case "Literal":
      state.currentText += literalText(ast.literal)
      return
    case "TemplateLiteral":
      for (const part of ast.parts) {
        visitTemplateLiteralPart(state, part, context, indentLevel)
      }
      return
    default:
      pushTemplateLiteralInterpolation(
        state,
        toTypeNode(ast, context, indentLevel).text,
      )
  }
}

const escapeTemplateLiteralText = (text: string): string =>
  text.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")

const templateLiteralTypeNode = (
  ast: AST.TemplateLiteral,
  context: RenderContext,
  indentLevel: number,
): RenderedType => {
  const state: TemplateLiteralState = {
    head: "",
    currentText: "",
    spans: [],
  }

  for (const part of ast.parts) {
    visitTemplateLiteralPart(state, part, context, indentLevel)
  }

  if (state.spans.length === 0) {
    return stringLiteralTypeNode(state.currentText)
  }

  const lastSpan = state.spans[state.spans.length - 1]

  if (lastSpan !== undefined) {
    lastSpan.text = state.currentText
  }

  return {
    text: `\`${escapeTemplateLiteralText(state.head)}${state.spans
      .map((span) => `\${${span.type}}${escapeTemplateLiteralText(span.text)}`)
      .join("")}\``,
    precedence: Precedence.Primary,
  }
}

const stripOptionalTupleUndefined = (ast: AST.AST): AST.AST => {
  if (!AST.isOptional(ast) || ast._tag !== "Union") {
    return ast
  }

  const definedTypes = ast.types.filter((type) => type._tag !== "Undefined")
  const [definedType] = definedTypes

  if (definedTypes.length === ast.types.length) {
    return ast
  }

  return definedTypes.length === 1 && definedType !== undefined
    ? definedType
    : new AST.Union(
        definedTypes,
        ast.mode,
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
      )
}

const tupleElementTypeNode = (
  ast: AST.AST,
  context: RenderContext,
  indentLevel: number,
): string => {
  const type = toTypeNode(
    stripOptionalTupleUndefined(ast),
    context,
    indentLevel,
  )
  const optionalSuffix = AST.isOptional(ast) ? "?" : ""
  const typeText = AST.isOptional(ast)
    ? withParenthesesIfNeeded(type, Precedence.Postfix)
    : type.text

  return prefixFirstLine(
    appendSuffix(typeText, optionalSuffix, context.options.newLine),
    indent(indentLevel),
    context.options.newLine,
  )
}

const restTupleElementTypeNode = (
  ast: AST.AST,
  context: RenderContext,
  indentLevel: number,
): string => {
  const type = toTypeNode(ast, context, indentLevel)

  return prefixFirstLine(
    appendSuffix(
      withParenthesesIfNeeded(type, Precedence.Postfix),
      "[]",
      context.options.newLine,
    ),
    `${indent(indentLevel)}...`,
    context.options.newLine,
  )
}

const arraysTypeNode = (
  ast: AST.Arrays,
  context: RenderContext,
  indentLevel: number,
): RenderedType => {
  const [restHead, ...restTail] = ast.rest

  if (
    ast.elements.length === 0 &&
    ast.rest.length === 1 &&
    restHead !== undefined
  ) {
    const arrayType = toTypeNode(restHead, context, indentLevel)
    const renderedArray = {
      text: appendSuffix(
        withParenthesesIfNeeded(arrayType, Precedence.Postfix),
        "[]",
        context.options.newLine,
      ),
      precedence: Precedence.Postfix,
    } satisfies RenderedType

    return ast.isMutable
      ? renderedArray
      : readonlyTypeNode(renderedArray, context)
  }

  const tupleMembers = [
    ...ast.elements.map((element) =>
      tupleElementTypeNode(element, context, indentLevel + 1),
    ),
    ...(restHead === undefined
      ? []
      : [
          restTupleElementTypeNode(restHead, context, indentLevel + 1),
          ...restTail.map((element) =>
            tupleElementTypeNode(element, context, indentLevel + 1),
          ),
        ]),
  ]
  const tupleLines = tupleMembers.map((member, index) =>
    appendSuffix(
      member,
      index === tupleMembers.length - 1 ? "" : ",",
      context.options.newLine,
    ),
  )

  return {
    text:
      tupleLines.length === 0
        ? ast.isMutable
          ? "[]"
          : "readonly []"
        : [
            ast.isMutable ? "[" : "readonly [",
            ...tupleLines,
            `${indent(indentLevel)}]`,
          ].join(context.options.newLine),
    precedence: Precedence.Primary,
  }
}

const declarationTypeNode = (
  ast: AST.Declaration,
  context: RenderContext,
  indentLevel: number,
): RenderedType => {
  const identifier = AST.resolveIdentifier(ast)

  if (identifier === undefined) {
    return unknownTypeNode()
  }

  const typeArguments = ast.typeParameters.map((typeParameter) =>
    toTypeNode(typeParameter, context, indentLevel),
  )

  return referenceTypeNode(identifier, typeArguments)
}

const suspendTypeNode = (
  ast: AST.Suspend,
  context: RenderContext,
  indentLevel: number,
): RenderedType => toTypeNode(ast.thunk(), context, indentLevel)

const toTypeNode = (
  ast: AST.AST,
  context: RenderContext,
  indentLevel: number,
): RenderedType => {
  if (context.activeNodes.has(ast)) {
    return cycleTypeNode(ast)
  }

  context.activeNodes.add(ast)

  try {
    switch (ast._tag) {
      case "String":
        return primitiveTypeNode("string")
      case "Number":
        return primitiveTypeNode("number")
      case "Boolean":
        return primitiveTypeNode("boolean")
      case "BigInt":
        return primitiveTypeNode("bigint")
      case "Symbol":
        return primitiveTypeNode("symbol")
      case "Any":
        return primitiveTypeNode("any")
      case "Unknown":
        return unknownTypeNode()
      case "Void":
        return primitiveTypeNode("void")
      case "Never":
        return primitiveTypeNode("never")
      case "Undefined":
        return primitiveTypeNode("undefined")
      case "Null":
        return nullTypeNode()
      case "ObjectKeyword":
        return primitiveTypeNode("object")
      case "Literal":
        return literalTypeNode(ast)
      case "UniqueSymbol":
        return uniqueSymbolTypeNode(ast)
      case "Declaration":
        return declarationTypeNode(ast, context, indentLevel)
      case "Enum":
        return enumTypeNode(ast)
      case "TemplateLiteral":
        return templateLiteralTypeNode(ast, context, indentLevel)
      case "Objects":
        return objectsTypeNode(ast, context, indentLevel)
      case "Arrays":
        return arraysTypeNode(ast, context, indentLevel)
      case "Union":
        return unionTypeNode(ast, context, indentLevel)
      case "Suspend":
        return suspendTypeNode(ast, context, indentLevel)
      default:
        return unknownTypeNode()
    }
  } finally {
    context.activeNodes.delete(ast)
  }
}

export const printNode = (
  node: PrintableNode,
  _options?: PrinterOptions,
): string => node.text

export const render = (
  schema: Schema.Top,
  options?: PrinterOptions,
): string => {
  const printerOptions = normalizeOptions(options)
  const ast = AST.toType(schema.ast)
  const rendered = toTypeNode(
    ast,
    {
      activeNodes: new Set(),
      options: printerOptions,
    },
    0,
  )
  const documentation = rootDocumentation(ast)

  return printNode(
    {
      text:
        documentation === undefined
          ? rendered.text
          : `${renderJsDoc(documentation, 0, printerOptions)}${printerOptions.newLine}${rendered.text}`,
    },
    printerOptions,
  )
}

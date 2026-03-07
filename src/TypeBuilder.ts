import { Schema, SchemaAST as AST } from "effect"
import * as ts from "typescript"

const resolveDocumentation = AST.resolveAt<string>("documentation")
const identifierPattern = /^[$A-Z_a-z][$0-9A-Z_a-z]*$/u

const unknownTypeNode = (): ts.KeywordTypeNode =>
  ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)

const primitiveTypeNode = (
  kind: ts.KeywordTypeSyntaxKind,
): ts.KeywordTypeNode => ts.factory.createKeywordTypeNode(kind)

type RenderContext = {
  activeNodes: Set<AST.AST>
}

const readonlyTypeNode = (type: ts.TypeNode): ts.TypeOperatorNode =>
  ts.factory.createTypeOperatorNode(ts.SyntaxKind.ReadonlyKeyword, type)

const nullTypeNode = (): ts.LiteralTypeNode =>
  ts.factory.createLiteralTypeNode(ts.factory.createNull())

const stringLiteralTypeNode = (value: string): ts.LiteralTypeNode =>
  ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(value))

const referenceTypeNode = (
  identifier: string,
  typeArguments?: ReadonlyArray<ts.TypeNode>,
): ts.TypeReferenceNode =>
  ts.factory.createTypeReferenceNode(
    ts.factory.createIdentifier(identifier),
    typeArguments,
  )

const cycleTypeNode = (ast: AST.AST): ts.TypeNode => {
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

const numberLiteralTypeNode = (value: number): ts.LiteralTypeNode => {
  if (Object.is(value, -0) || value < 0) {
    return ts.factory.createLiteralTypeNode(
      ts.factory.createPrefixUnaryExpression(
        ts.SyntaxKind.MinusToken,
        ts.factory.createNumericLiteral(-value),
      ),
    )
  }

  return ts.factory.createLiteralTypeNode(
    ts.factory.createNumericLiteral(value),
  )
}

const bigintLiteralTypeNode = (value: bigint): ts.LiteralTypeNode => {
  if (value < 0n) {
    return ts.factory.createLiteralTypeNode(
      ts.factory.createPrefixUnaryExpression(
        ts.SyntaxKind.MinusToken,
        ts.factory.createBigIntLiteral(`${-value}n`),
      ),
    )
  }

  return ts.factory.createLiteralTypeNode(
    ts.factory.createBigIntLiteral(`${value}n`),
  )
}

const literalTypeNode = (ast: AST.Literal): ts.LiteralTypeNode => {
  switch (typeof ast.literal) {
    case "string":
      return stringLiteralTypeNode(ast.literal)
    case "number":
      return numberLiteralTypeNode(ast.literal)
    case "boolean":
      return ts.factory.createLiteralTypeNode(
        ast.literal ? ts.factory.createTrue() : ts.factory.createFalse(),
      )
    case "bigint":
      return bigintLiteralTypeNode(ast.literal)
  }
}

const unionOfTypeNodes = (types: ReadonlyArray<ts.TypeNode>): ts.TypeNode => {
  const [firstType, ...restTypes] = types

  if (firstType === undefined) {
    return primitiveTypeNode(ts.SyntaxKind.NeverKeyword)
  }

  return restTypes.length === 0
    ? firstType
    : ts.factory.createUnionTypeNode(types)
}

const uniqueSymbolTypeNode = (ast: AST.UniqueSymbol): ts.TypeNode => {
  const description = ast.symbol.description

  if (description === undefined) {
    return ts.factory.createTypeOperatorNode(
      ts.SyntaxKind.UniqueKeyword,
      primitiveTypeNode(ts.SyntaxKind.SymbolKeyword),
    )
  }

  return ts.factory.createTypeQueryNode(
    ts.factory.createIdentifier(`Symbol.for(${JSON.stringify(description)})`),
  )
}

const symbolExpression = (symbol: symbol): ts.Expression => {
  const description = symbol.description

  if (description === undefined) {
    return ts.factory.createCallExpression(
      ts.factory.createIdentifier("Symbol"),
      undefined,
      [],
    )
  }

  return ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(
      ts.factory.createIdentifier("Symbol"),
      "for",
    ),
    undefined,
    [ts.factory.createStringLiteral(description)],
  )
}

const propertyName = (name: PropertyKey): ts.PropertyName => {
  switch (typeof name) {
    case "string":
      return identifierPattern.test(name)
        ? ts.factory.createIdentifier(name)
        : ts.factory.createStringLiteral(name)
    case "number":
      return ts.factory.createNumericLiteral(name)
    case "symbol":
      return ts.factory.createComputedPropertyName(symbolExpression(name))
  }
}

const jsDocText = (documentation: string): string => {
  const lines = documentation.replaceAll("*/", "*\\/").split(/\r?\n/u)

  return lines.length === 1
    ? `* ${lines[0]} `
    : `*\n * ${lines.join("\n * ")}\n `
}

const withJsDoc = <T extends ts.Node>(
  node: T,
  documentation: string | undefined,
): T => {
  if (documentation === undefined) {
    return node
  }

  ts.addSyntheticLeadingComment(
    node,
    ts.SyntaxKind.MultiLineCommentTrivia,
    jsDocText(documentation),
    true,
  )

  return node
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
): ts.PropertySignature =>
  withJsDoc(
    ts.factory.createPropertySignature(
      propertySignature.type.context?.isMutable === true
        ? undefined
        : [ts.factory.createModifier(ts.SyntaxKind.ReadonlyKeyword)],
      propertyName(propertySignature.name),
      AST.isOptional(propertySignature.type)
        ? ts.factory.createToken(ts.SyntaxKind.QuestionToken)
        : undefined,
      toTypeNode(propertySignature.type, context),
    ),
    resolveDocumentation(propertySignature.type),
  )

const indexSignatureTypeElement = (
  indexSignature: AST.IndexSignature,
  context: RenderContext,
): ts.IndexSignatureDeclaration =>
  ts.factory.createIndexSignature(
    undefined,
    [
      ts.factory.createParameterDeclaration(
        undefined,
        undefined,
        "x",
        undefined,
        toTypeNode(indexSignature.parameter, context),
        undefined,
      ),
    ],
    toTypeNode(indexSignature.type, context),
  )

const objectsTypeNode = (
  ast: AST.Objects,
  context: RenderContext,
): ts.TypeLiteralNode =>
  ts.factory.createTypeLiteralNode([
    ...ast.propertySignatures.map((propertySignature) =>
      propertySignatureTypeElement(propertySignature, context),
    ),
    ...ast.indexSignatures.map((indexSignature) =>
      indexSignatureTypeElement(indexSignature, context),
    ),
  ])

const unionTypeNode = (ast: AST.Union, context: RenderContext): ts.TypeNode =>
  unionOfTypeNodes(ast.types.map((type) => toTypeNode(type, context)))

const enumTypeNode = (ast: AST.Enum): ts.TypeNode =>
  unionOfTypeNodes(
    ast.enums.map(([, value]) =>
      typeof value === "string"
        ? stringLiteralTypeNode(value)
        : numberLiteralTypeNode(value),
    ),
  )

type TemplateLiteralSpan = {
  type: ts.TypeNode
  text: string
}

type TemplateLiteralState = {
  head: string
  currentText: string
  spans: Array<TemplateLiteralSpan>
}

const pushTemplateLiteralInterpolation = (
  state: TemplateLiteralState,
  type: ts.TypeNode,
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
): void => {
  switch (ast._tag) {
    case "Literal":
      state.currentText += literalText(ast.literal)
      return
    case "TemplateLiteral":
      for (const part of ast.parts) {
        visitTemplateLiteralPart(state, part, context)
      }
      return
    default:
      pushTemplateLiteralInterpolation(state, toTypeNode(ast, context))
  }
}

const templateLiteralTypeNode = (
  ast: AST.TemplateLiteral,
  context: RenderContext,
): ts.TypeNode => {
  const state: TemplateLiteralState = {
    head: "",
    currentText: "",
    spans: [],
  }

  for (const part of ast.parts) {
    visitTemplateLiteralPart(state, part, context)
  }

  if (state.spans.length === 0) {
    return stringLiteralTypeNode(state.currentText)
  }

  const lastSpan = state.spans[state.spans.length - 1]

  if (lastSpan !== undefined) {
    lastSpan.text = state.currentText
  }

  return ts.factory.createTemplateLiteralType(
    ts.factory.createTemplateHead(state.head),
    state.spans.map((span, index) =>
      ts.factory.createTemplateLiteralTypeSpan(
        span.type,
        index === state.spans.length - 1
          ? ts.factory.createTemplateTail(span.text)
          : ts.factory.createTemplateMiddle(span.text),
      ),
    ),
  )
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
): ts.TypeNode => {
  const type = toTypeNode(stripOptionalTupleUndefined(ast), context)

  return AST.isOptional(ast) ? ts.factory.createOptionalTypeNode(type) : type
}

const arraysTypeNode = (
  ast: AST.Arrays,
  context: RenderContext,
): ts.TypeNode => {
  const [restHead, ...restTail] = ast.rest

  if (
    ast.elements.length === 0 &&
    ast.rest.length === 1 &&
    restHead !== undefined
  ) {
    const arrayType = ts.factory.createArrayTypeNode(
      toTypeNode(restHead, context),
    )

    return ast.isMutable ? arrayType : readonlyTypeNode(arrayType)
  }

  const tupleType = ts.factory.createTupleTypeNode([
    ...ast.elements.map((element) => tupleElementTypeNode(element, context)),
    ...(restHead === undefined
      ? []
      : [
          ts.factory.createRestTypeNode(
            ts.factory.createArrayTypeNode(toTypeNode(restHead, context)),
          ),
          ...restTail.map((element) => tupleElementTypeNode(element, context)),
        ]),
  ])

  return ast.isMutable ? tupleType : readonlyTypeNode(tupleType)
}

const declarationTypeNode = (
  ast: AST.Declaration,
  context: RenderContext,
): ts.TypeNode => {
  const identifier = AST.resolveIdentifier(ast)

  if (identifier === undefined) {
    return unknownTypeNode()
  }

  const typeArguments = ast.typeParameters.map((typeParameter) =>
    toTypeNode(typeParameter, context),
  )

  return referenceTypeNode(identifier, typeArguments)
}

const suspendTypeNode = (
  ast: AST.Suspend,
  context: RenderContext,
): ts.TypeNode => toTypeNode(ast.thunk(), context)

const toTypeNode = (ast: AST.AST, context: RenderContext): ts.TypeNode => {
  if (context.activeNodes.has(ast)) {
    return cycleTypeNode(ast)
  }

  context.activeNodes.add(ast)

  try {
    switch (ast._tag) {
      case "String":
        return primitiveTypeNode(ts.SyntaxKind.StringKeyword)
      case "Number":
        return primitiveTypeNode(ts.SyntaxKind.NumberKeyword)
      case "Boolean":
        return primitiveTypeNode(ts.SyntaxKind.BooleanKeyword)
      case "BigInt":
        return primitiveTypeNode(ts.SyntaxKind.BigIntKeyword)
      case "Symbol":
        return primitiveTypeNode(ts.SyntaxKind.SymbolKeyword)
      case "Any":
        return primitiveTypeNode(ts.SyntaxKind.AnyKeyword)
      case "Unknown":
        return unknownTypeNode()
      case "Void":
        return primitiveTypeNode(ts.SyntaxKind.VoidKeyword)
      case "Never":
        return primitiveTypeNode(ts.SyntaxKind.NeverKeyword)
      case "Undefined":
        return primitiveTypeNode(ts.SyntaxKind.UndefinedKeyword)
      case "Null":
        return nullTypeNode()
      case "ObjectKeyword":
        return primitiveTypeNode(ts.SyntaxKind.ObjectKeyword)
      case "Literal":
        return literalTypeNode(ast)
      case "UniqueSymbol":
        return uniqueSymbolTypeNode(ast)
      case "Declaration":
        return declarationTypeNode(ast, context)
      case "Enum":
        return enumTypeNode(ast)
      case "TemplateLiteral":
        return templateLiteralTypeNode(ast, context)
      case "Objects":
        return objectsTypeNode(ast, context)
      case "Arrays":
        return arraysTypeNode(ast, context)
      case "Union":
        return unionTypeNode(ast, context)
      case "Suspend":
        return suspendTypeNode(ast, context)
      default:
        return unknownTypeNode()
    }
  } finally {
    context.activeNodes.delete(ast)
  }
}

export const printNode = (
  node: ts.Node,
  options?: ts.PrinterOptions,
): string => {
  const sourceFile = ts.createSourceFile(
    "print.ts",
    "",
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  )
  const printer = ts.createPrinter(options)

  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile)
}

export const render = (
  schema: Schema.Top,
  options?: ts.PrinterOptions,
): string => {
  const ast = AST.toType(schema.ast)

  return printNode(
    withJsDoc(
      toTypeNode(ast, { activeNodes: new Set() }),
      rootDocumentation(ast),
    ),
    options,
  )
}

import { Schema, SchemaAST as AST } from "effect"
import * as ts from "typescript"

const resolveDocumentation = AST.resolveAt<string>("documentation")
const identifierPattern = /^[$A-Z_a-z][$0-9A-Z_a-z]*$/u

const unknownTypeNode = (): ts.KeywordTypeNode =>
  ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)

const primitiveTypeNode = (
  kind: ts.KeywordTypeSyntaxKind,
): ts.KeywordTypeNode => ts.factory.createKeywordTypeNode(kind)

const readonlyTypeNode = (type: ts.TypeNode): ts.TypeOperatorNode =>
  ts.factory.createTypeOperatorNode(ts.SyntaxKind.ReadonlyKeyword, type)

const nullTypeNode = (): ts.LiteralTypeNode =>
  ts.factory.createLiteralTypeNode(ts.factory.createNull())

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
      return ts.factory.createLiteralTypeNode(
        ts.factory.createStringLiteral(ast.literal),
      )
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

const propertySignatureTypeElement = (
  propertySignature: AST.PropertySignature,
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
      toTypeNode(propertySignature.type),
    ),
    resolveDocumentation(propertySignature.type),
  )

const indexSignatureTypeElement = (
  indexSignature: AST.IndexSignature,
): ts.IndexSignatureDeclaration =>
  ts.factory.createIndexSignature(
    undefined,
    [
      ts.factory.createParameterDeclaration(
        undefined,
        undefined,
        "x",
        undefined,
        toTypeNode(indexSignature.parameter),
        undefined,
      ),
    ],
    toTypeNode(indexSignature.type),
  )

const objectsTypeNode = (ast: AST.Objects): ts.TypeLiteralNode =>
  ts.factory.createTypeLiteralNode([
    ...ast.propertySignatures.map(propertySignatureTypeElement),
    ...ast.indexSignatures.map(indexSignatureTypeElement),
  ])

const unionTypeNode = (ast: AST.Union): ts.TypeNode => {
  const [firstType, ...restTypes] = ast.types

  if (firstType === undefined) {
    return primitiveTypeNode(ts.SyntaxKind.NeverKeyword)
  }

  if (restTypes.length === 0) {
    return toTypeNode(firstType)
  }

  return ts.factory.createUnionTypeNode(ast.types.map(toTypeNode))
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

const tupleElementTypeNode = (ast: AST.AST): ts.TypeNode => {
  const type = toTypeNode(stripOptionalTupleUndefined(ast))

  return AST.isOptional(ast) ? ts.factory.createOptionalTypeNode(type) : type
}

const arraysTypeNode = (ast: AST.Arrays): ts.TypeNode => {
  const [restHead, ...restTail] = ast.rest

  if (
    ast.elements.length === 0 &&
    ast.rest.length === 1 &&
    restHead !== undefined
  ) {
    const arrayType = ts.factory.createArrayTypeNode(toTypeNode(restHead))

    return ast.isMutable ? arrayType : readonlyTypeNode(arrayType)
  }

  const tupleType = ts.factory.createTupleTypeNode([
    ...ast.elements.map(tupleElementTypeNode),
    ...(restHead === undefined
      ? []
      : [
          ts.factory.createRestTypeNode(
            ts.factory.createArrayTypeNode(toTypeNode(restHead)),
          ),
          ...restTail.map(tupleElementTypeNode),
        ]),
  ])

  return ast.isMutable ? tupleType : readonlyTypeNode(tupleType)
}

const toTypeNode = (ast: AST.AST): ts.TypeNode => {
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
    case "Objects":
      return objectsTypeNode(ast)
    case "Arrays":
      return arraysTypeNode(ast)
    case "Union":
      return unionTypeNode(ast)
    default:
      return unknownTypeNode()
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
): string => printNode(toTypeNode(AST.toType(schema.ast)), options)

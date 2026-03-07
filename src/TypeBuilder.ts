import { Schema, SchemaAST as AST } from "effect"
import * as ts from "typescript"

const unknownTypeNode = (): ts.KeywordTypeNode =>
  ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)

const primitiveTypeNode = (
  kind: ts.KeywordTypeSyntaxKind,
): ts.KeywordTypeNode => ts.factory.createKeywordTypeNode(kind)

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

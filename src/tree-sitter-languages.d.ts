declare module "tree-sitter" {
  interface Point {
    readonly row: number
    readonly column: number
  }

  interface SyntaxNode {
    readonly type: string
    readonly text: string
    readonly startPosition: Point
    readonly endPosition: Point
    readonly namedChildren: ReadonlyArray<SyntaxNode>
    childForFieldName(name: string): SyntaxNode | null
  }

  interface Tree {
    readonly rootNode: SyntaxNode
  }

  export default class Parser {
    setLanguage(language: unknown): void
    parse(input: string): Tree
  }
}

declare module "tree-sitter-javascript" {
  const language: unknown
  export default language
}

declare module "tree-sitter-typescript" {
  const languages: {
    readonly typescript: unknown
    readonly tsx: unknown
  }
  export default languages
}

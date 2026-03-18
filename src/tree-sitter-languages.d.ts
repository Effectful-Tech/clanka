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

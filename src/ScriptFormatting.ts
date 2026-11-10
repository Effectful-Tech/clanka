import TreeSitter, { type SyntaxNode } from "tree-sitter"
import JavaScript from "tree-sitter-javascript"

const parser = new TreeSitter()
parser.setLanguage(JavaScript)

/** Adds display-only line breaks, leaving execution and model history untouched. */
export const formatScript = (script: string): string => {
  try {
    const tree = parser.parse(script, undefined, {
      // Include room for the UTF-16 terminator, even for large file contents.
      bufferSize: Math.max(32 * 1024, script.length + 1),
    })
    if (tree.rootNode.hasError) return script
    const breaks = new Set<number>()
    const visit = (node: SyntaxNode): void => {
      // Treat literals as opaque, including code inside template substitutions.
      if (
        ["string", "template_string", "regex", "comment"].includes(node.type)
      ) {
        return
      }
      if (node.type === "for_statement") {
        const body = node.childForFieldName("body")
        if (body) visit(body)
        return
      }
      if (node.type === ";") breaks.add(node.endIndex)
      if (node.type === "statement_block") {
        breaks.add(node.startIndex + 1)
      }
      if (node.type === "program" || node.type === "statement_block") {
        for (const child of node.namedChildren) {
          if (child.type !== "comment") breaks.add(child.endIndex)
        }
      }
      for (const child of node.children) visit(child)
    }
    visit(tree.rootNode)

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
  } catch {
    return script
  }
}

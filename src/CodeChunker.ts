/**
 * @since 1.0.0
 */
import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { pipe } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as ServiceMap from "effect/ServiceMap"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import TreeSitter, { type SyntaxNode } from "tree-sitter"
import TreeSitterJavaScript from "tree-sitter-javascript"
import TreeSitterTypeScript from "tree-sitter-typescript"

/**
 * @since 1.0.0
 * @category Models
 */
export interface CodeChunk {
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly name: string | undefined
  readonly type: ChunkType | undefined
  readonly parent: string | undefined
  readonly content: string
}

/**
 * @since 1.0.0
 * @category Models
 */
export type ChunkType =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type-alias"
  | "enum"
  | "variable"

/**
 * @since 1.0.0
 * @category Services
 */
export class CodeChunker extends ServiceMap.Service<
  CodeChunker,
  {
    listFiles(options: {
      readonly root: string
      readonly maxFileSize?: string | undefined
    }): Effect.Effect<ReadonlyArray<string>>
    chunkFile(options: {
      readonly root: string
      readonly path: string
      readonly chunkSize: number
      readonly chunkOverlap: number
    }): Effect.Effect<ReadonlyArray<CodeChunk>>
    chunkFiles(options: {
      readonly root: string
      readonly paths: ReadonlyArray<string>
      readonly chunkSize: number
      readonly chunkOverlap: number
    }): Stream.Stream<CodeChunk>
    chunkCodebase(options: {
      readonly root: string
      readonly maxFileSize?: string | undefined
      readonly chunkSize: number
      readonly chunkOverlap: number
    }): Stream.Stream<CodeChunk>
  }
>()("clanka/CodeChunker") {}

const sourceExtensions = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "cts",
  "cxx",
  "go",
  "gql",
  "graphql",
  "h",
  "hpp",
  "html",
  "ini",
  "java",
  "js",
  "jsx",
  "kt",
  "kts",
  "less",
  "lua",
  "mjs",
  "mts",
  "php",
  "py",
  "rb",
  "rs",
  "sass",
  "scala",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "ts",
  "tsx",
  "vue",
  "xml",
  "zsh",
])

const documentationExtensions = new Set([
  "adoc",
  "asciidoc",
  "md",
  "mdx",
  "rst",
  "txt",
])

const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
])

const normalizePath = (path: string): string => path.replace(/\\/g, "/")

const normalizeText = (content: string): string =>
  content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")

const meaningfulLinePattern = /[^\s\p{P}]/u

const isMeaningfulLine = (line: string): boolean =>
  meaningfulLinePattern.test(line)

interface LineRange {
  readonly startLine: number
  readonly endLine: number
}

interface ChunkSettings {
  readonly chunkSize: number
  readonly chunkOverlap: number
}

interface ChunkRange extends LineRange {
  readonly name: string | undefined
  readonly type: ChunkType | undefined
  readonly parent: string | undefined
}

const languageByExtension = new Map<string, unknown>([
  ["js", TreeSitterJavaScript],
  ["jsx", TreeSitterJavaScript],
  ["ts", TreeSitterTypeScript.typescript],
  ["tsx", TreeSitterTypeScript.tsx],
])

// const ignoredTopLevelNodeTypes = new Set(["comment", "import_statement"])

/**
 * @since 1.0.0
 * @category Predicates
 */
export const isProbablyMinified = (content: string): boolean => {
  const normalized = normalizeText(content)
  if (normalized.length < 2_000) {
    return false
  }

  const lines = normalized.split("\n")
  if (lines.length <= 2) {
    return true
  }

  let longLines = 0
  for (const line of lines) {
    if (line.length >= 300) {
      longLines++
    }
  }

  return lines.length <= 20 && longLines / lines.length >= 0.8
}

/**
 * @since 1.0.0
 * @category Predicates
 */
export const isMeaningfulFile = (path: string): boolean => {
  const normalizedPath = normalizePath(path)
  const lowercasePath = normalizedPath.toLowerCase()
  const parts = lowercasePath.split("/")
  const fileName = parts.at(-1)
  if (fileName === undefined || fileName.length === 0) {
    return false
  }

  if (parts.some((part) => ignoredDirectories.has(part))) {
    return false
  }

  if (/\.min\.(?:css|js)$/i.test(fileName)) {
    return false
  }

  const extensionIndex = fileName.lastIndexOf(".")
  if (extensionIndex === -1) {
    return false
  }

  const extension = fileName.slice(extensionIndex + 1)
  return (
    sourceExtensions.has(extension) || documentationExtensions.has(extension)
  )
}

const resolveChunkSettings = (options: {
  readonly chunkSize: number
  readonly chunkOverlap: number
}): ChunkSettings => {
  const chunkSize = Math.max(1, options.chunkSize)
  const chunkOverlap = Math.max(
    0,
    Math.min(chunkSize - 1, options.chunkOverlap),
  )

  return {
    chunkSize,
    chunkOverlap,
  }
}

const getPathExtension = (path: string): string | undefined => {
  const fileName = path.split("/").at(-1)
  if (fileName === undefined) {
    return undefined
  }

  const extensionIndex = fileName.lastIndexOf(".")
  if (extensionIndex === -1) {
    return undefined
  }

  return fileName.slice(extensionIndex + 1).toLowerCase()
}

const resolveAstLanguage = (path: string): unknown => {
  const extension = getPathExtension(path)
  if (extension === undefined) {
    return undefined
  }

  return languageByExtension.get(extension)
}

const lineRangeFromNode = (node: SyntaxNode): LineRange => {
  const startLine = node.startPosition.row + 1
  const endLine = Math.max(startLine, node.endPosition.row + 1)
  return {
    startLine,
    endLine,
  }
}

const hasOnlyWhitespaceLines = (
  lines: ReadonlyArray<string>,
  startLine: number,
  endLine: number,
): boolean => {
  if (startLine > endLine) {
    return true
  }

  for (let lineIndex = startLine; lineIndex <= endLine; lineIndex++) {
    if ((lines[lineIndex - 1] ?? "").trim().length > 0) {
      return false
    }
  }

  return true
}

const lineRangeWithLeadingComments = (
  node: SyntaxNode,
  siblings: ReadonlyArray<SyntaxNode>,
  nodeIndex: number,
  lines: ReadonlyArray<string>,
): LineRange => {
  const baseRange = lineRangeFromNode(node)
  let startLine = baseRange.startLine

  for (let index = nodeIndex - 1; index >= 0; index--) {
    const sibling = siblings[index]!
    if (sibling.type !== "comment") {
      break
    }

    const commentRange = lineRangeFromNode(sibling)
    if (
      !hasOnlyWhitespaceLines(lines, commentRange.endLine + 1, startLine - 1)
    ) {
      break
    }

    startLine = commentRange.startLine
  }

  return {
    startLine,
    endLine: baseRange.endLine,
  }
}

const normalizeLineRange = (
  range: LineRange,
  lineCount: number,
): LineRange | undefined => {
  const startLine = Math.max(1, Math.min(lineCount, range.startLine))
  const endLine = Math.max(1, Math.min(lineCount, range.endLine))

  if (endLine < startLine) {
    return undefined
  }

  return {
    startLine,
    endLine,
  }
}

const splitRange = (
  range: LineRange,
  settings: ChunkSettings,
): ReadonlyArray<LineRange> => {
  const lineCount = range.endLine - range.startLine + 1
  if (lineCount <= settings.chunkSize) {
    return [range]
  }

  const step = settings.chunkSize - settings.chunkOverlap
  const out = [] as Array<LineRange>

  for (
    let startLine = range.startLine;
    startLine <= range.endLine;
    startLine += step
  ) {
    const endLine = Math.min(range.endLine, startLine + settings.chunkSize - 1)
    out.push({
      startLine,
      endLine,
    })

    if (endLine >= range.endLine) {
      break
    }
  }

  return out
}

const nodeText = (node: SyntaxNode | null): string | undefined => {
  if (node === null) {
    return undefined
  }

  const value = node.text.trim().replace(/\s+/g, " ")
  return value.length === 0 ? undefined : value
}

const nodeFieldText = (
  node: SyntaxNode,
  fieldName: string,
): string | undefined => nodeText(node.childForFieldName(fieldName))

const unwrapExportNode = (node: SyntaxNode): SyntaxNode => {
  if (node.type !== "export_statement") {
    return node
  }

  return node.childForFieldName("declaration") ?? node
}

const variableDeclarators = (node: SyntaxNode): ReadonlyArray<SyntaxNode> =>
  node.namedChildren.filter((child) => child.type === "variable_declarator")

const variableTypeFromDeclarator = (node: SyntaxNode): ChunkType => {
  const value = node.childForFieldName("value")
  if (value !== null && value.type.includes("function")) {
    return "function"
  }
  return "variable"
}

const variableTypeFromDeclaration = (node: SyntaxNode): ChunkType => {
  const declarators = variableDeclarators(node)
  if (
    declarators.some(
      (declarator) => variableTypeFromDeclarator(declarator) === "function",
    )
  ) {
    return "function"
  }
  return "variable"
}

const chunkTypeFromNode = (node: SyntaxNode): ChunkType | undefined => {
  switch (node.type) {
    case "class_declaration":
      return "class"
    case "enum_declaration":
      return "enum"
    case "function_declaration":
    case "generator_function_declaration":
      return "function"
    case "interface_declaration":
      return "interface"
    case "generator_method_definition":
    case "method_definition":
      return "method"
    case "type_alias_declaration":
      return "type-alias"
    case "lexical_declaration":
    case "variable_declaration":
      return variableTypeFromDeclaration(node)
    case "variable_declarator":
      return variableTypeFromDeclarator(node)
    default:
      return undefined
  }
}

const variableNamesFromDeclaration = (node: SyntaxNode): string | undefined => {
  const names = variableDeclarators(node)
    .map((declarator) => nodeFieldText(declarator, "name"))
    .filter((name): name is string => name !== undefined)

  if (names.length === 0) {
    return undefined
  }

  return names.join(", ")
}

const nameFromNode = (node: SyntaxNode): string | undefined => {
  switch (node.type) {
    case "class_declaration":
    case "enum_declaration":
    case "function_declaration":
    case "generator_function_declaration":
    case "interface_declaration":
    case "generator_method_definition":
    case "method_definition":
    case "type_alias_declaration":
    case "variable_declarator":
      return nodeFieldText(node, "name")
    case "lexical_declaration":
    case "variable_declaration":
      return variableNamesFromDeclaration(node)
    default:
      return undefined
  }
}

const formatParent = (
  type: ChunkType | undefined,
  name: string | undefined,
): string | undefined => {
  if (type === undefined && name === undefined) {
    return undefined
  }
  if (type === undefined) {
    return name
  }
  if (name === undefined) {
    return type
  }
  return type + " " + name
}

const collectClassMethodRanges = (
  classNode: SyntaxNode,
  parent: string | undefined,
  lines: ReadonlyArray<string>,
): ReadonlyArray<ChunkRange> => {
  const body = classNode.childForFieldName("body")
  if (body === null) {
    return []
  }

  const out = [] as Array<ChunkRange>
  for (let index = 0; index < body.namedChildren.length; index++) {
    const child = body.namedChildren[index]!
    if (!child.type.includes("method")) {
      continue
    }

    out.push({
      ...lineRangeWithLeadingComments(child, body.namedChildren, index, lines),
      name: nameFromNode(child),
      type: chunkTypeFromNode(child),
      parent,
    })
  }

  return out
}

const collectAstRanges = (
  path: string,
  content: string,
  lines: ReadonlyArray<string>,
): ReadonlyArray<ChunkRange> => {
  const language = resolveAstLanguage(path)
  if (language === undefined) {
    return []
  }

  try {
    const parser = new TreeSitter()
    parser.setLanguage(language)
    const tree = parser.parse(content, undefined, {
      bufferSize: 1024 * 1024,
    })
    const out = [] as Array<ChunkRange>

    const topLevelNodes = tree.rootNode.namedChildren
    for (let index = 0; index < topLevelNodes.length; index++) {
      const topLevelNode = topLevelNodes[index]!
      if (
        topLevelNode.type === "comment" ||
        topLevelNode.type.includes("import")
      ) {
        continue
      }

      const declarationNode = unwrapExportNode(topLevelNode)
      const type = chunkTypeFromNode(declarationNode)
      const name = nameFromNode(declarationNode)

      out.push({
        ...lineRangeWithLeadingComments(
          topLevelNode,
          topLevelNodes,
          index,
          lines,
        ),
        name,
        type,
        parent: undefined,
      })

      if (declarationNode.type === "class_declaration") {
        const parent = formatParent(type, name)
        out.push(...collectClassMethodRanges(declarationNode, parent, lines))
      }
    }

    return out
  } catch {
    return []
  }
}

const chunksFromRanges = (
  path: string,
  lines: ReadonlyArray<string>,
  ranges: ReadonlyArray<ChunkRange>,
  settings: ChunkSettings,
): ReadonlyArray<CodeChunk> => {
  const hasMethodChildRange = (
    classRange: LineRange & { readonly name: string | undefined },
  ) => {
    const parent = formatParent("class", classRange.name)
    return ranges.some(
      (range) =>
        range.type === "method" &&
        range.parent === parent &&
        range.startLine >= classRange.startLine &&
        range.endLine <= classRange.endLine,
    )
  }

  const out = [] as Array<CodeChunk>
  const seen = new Set<string>()

  for (const range of ranges) {
    const normalizedRange = normalizeLineRange(range, lines.length)
    if (normalizedRange === undefined) {
      continue
    }

    const allSegments = splitRange(normalizedRange, settings)
    const segments =
      range.type === "class" &&
      allSegments.length > 1 &&
      hasMethodChildRange({ ...normalizedRange, name: range.name })
        ? [allSegments[0]!]
        : allSegments

    for (const segment of segments) {
      const key =
        String(segment.startLine) +
        ":" +
        String(segment.endLine) +
        ":" +
        (range.name ?? "") +
        ":" +
        (range.type ?? "") +
        ":" +
        (range.parent ?? "")
      if (seen.has(key)) {
        continue
      }
      seen.add(key)

      const chunkLines = lines.slice(segment.startLine - 1, segment.endLine)
      if (!chunkLines.some(isMeaningfulLine)) {
        continue
      }

      out.push({
        path,
        startLine: segment.startLine,
        endLine: segment.endLine,
        name: range.name,
        type: range.type,
        parent: range.parent,
        content: chunkLines.join("\n"),
      })
    }
  }

  return out.toSorted(
    (left, right) =>
      left.startLine - right.startLine ||
      left.endLine - right.endLine ||
      (left.name ?? "").localeCompare(right.name ?? ""),
  )
}

const chunkWithLineWindows = (
  path: string,
  lines: ReadonlyArray<string>,
  settings: ChunkSettings,
): ReadonlyArray<CodeChunk> => {
  const step = settings.chunkSize - settings.chunkOverlap
  const out = [] as Array<CodeChunk>

  for (let index = 0; index < lines.length; ) {
    if (!isMeaningfulLine(lines[index]!)) {
      index++
      continue
    }

    const start = index
    const end = Math.min(lines.length, start + settings.chunkSize)
    const chunkLines = lines.slice(start, end)

    out.push({
      path,
      startLine: start + 1,
      endLine: end,
      name: undefined,
      type: undefined,
      parent: undefined,
      content: chunkLines.join("\n"),
    })

    index += step

    if (end >= lines.length) {
      break
    }
  }

  return out
}

/**
 * @since 1.0.0
 * @category Constructors
 */
export const chunkFileContent = (
  path: string,
  content: string,
  options: {
    readonly chunkSize: number
    readonly chunkOverlap: number
  },
): ReadonlyArray<CodeChunk> => {
  if (content.trim().length === 0 || isProbablyMinified(content)) {
    return []
  }

  const normalizedPath = normalizePath(path)
  const normalizedContent = normalizeText(content)
  const lines = normalizedContent.split("\n")
  if (lines.at(-1) === "") {
    lines.pop()
  }
  if (lines.length === 0) {
    return []
  }

  const settings = resolveChunkSettings(options)
  const astRanges = collectAstRanges(normalizedPath, normalizedContent, lines)
  if (astRanges.length > 0) {
    const astChunks = chunksFromRanges(
      normalizedPath,
      lines,
      astRanges,
      settings,
    )
    if (astChunks.length > 0) {
      return astChunks
    }
  }

  return chunkWithLineWindows(normalizedPath, lines, settings)
}

/**
 * @since 1.0.0
 * @category Layers
 */
export const layer: Layer.Layer<
  CodeChunker,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> = Layer.effect(
  CodeChunker,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

    const listFiles: CodeChunker["Service"]["listFiles"] = Effect.fn(
      "CodeChunker.listFiles",
    )(function* (options): Effect.fn.Return<ReadonlyArray<string>> {
      const root = pathService.resolve(options.root)
      const maxFileSize = options.maxFileSize ?? "1M"

      return yield* pipe(
        spawner.streamLines(
          ChildProcess.make(
            "rg",
            [
              "--files",
              "--hidden",
              "--max-filesize",
              maxFileSize,
              "--glob",
              "!.git",
            ],
            {
              cwd: root,
              stdin: "ignore",
            },
          ),
        ),
        Stream.runCollect,
        Effect.map(Array.fromIterable),
        Effect.map((entries) =>
          entries
            .map((entry) => normalizePath(entry.trim()))
            .filter((entry) => entry.length > 0 && isMeaningfulFile(entry))
            .sort((left, right) => left.localeCompare(right)),
        ),
        Effect.orDie,
      )
    })

    const chunkFile: CodeChunker["Service"]["chunkFile"] = Effect.fn(
      "CodeChunker.chunkFile",
    )(function* (options): Effect.fn.Return<ReadonlyArray<CodeChunk>> {
      const root = pathService.resolve(options.root)
      const absolutePath = pathService.resolve(root, options.path)
      const path = normalizePath(pathService.relative(root, absolutePath))

      if (
        path.length === 0 ||
        path === ".." ||
        path.startsWith("../") ||
        !isMeaningfulFile(path)
      ) {
        return []
      }

      return yield* pipe(
        fs.readFileString(absolutePath),
        Effect.map((content) => chunkFileContent(path, content, options)),
        Effect.catch(() => Effect.succeed([])),
      )
    })

    const chunkFiles: CodeChunker["Service"]["chunkFiles"] = (options) =>
      Stream.fromArray(options.paths).pipe(
        Stream.flatMap(
          (path) =>
            pipe(
              chunkFile({
                root: options.root,
                path,
                chunkSize: options.chunkSize,
                chunkOverlap: options.chunkOverlap,
              }),
              Stream.fromArrayEffect,
            ),
          { concurrency: 5 },
        ),
      )

    const chunkCodebase: CodeChunker["Service"]["chunkCodebase"] =
      Effect.fnUntraced(function* (options) {
        const root = pathService.resolve(options.root)
        const files = yield* listFiles({
          root,
          ...(options.maxFileSize === undefined
            ? {}
            : { maxFileSize: options.maxFileSize }),
        })

        return chunkFiles({
          root,
          paths: files,
          chunkSize: options.chunkSize,
          chunkOverlap: options.chunkOverlap,
        })
      }, Stream.unwrap)

    return CodeChunker.of({
      listFiles,
      chunkFile,
      chunkFiles,
      chunkCodebase,
    })
  }),
)

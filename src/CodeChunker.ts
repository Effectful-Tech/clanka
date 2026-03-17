/**
 * @since 1.0.0
 */
import { createHash } from "node:crypto"
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

/**
 * @since 1.0.0
 * @category Models
 */
export interface CodeChunk {
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly contentHash: string
  readonly content: string
}

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
  "json",
  "jsonc",
  "jsx",
  "kt",
  "kts",
  "less",
  "lua",
  "mjs",
  "mts",
  "php",
  "properties",
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
  "toml",
  "ts",
  "tsx",
  "vue",
  "xml",
  "yaml",
  "yml",
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

const allowedBareFileNames = new Set([
  ".editorconfig",
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  "dockerfile",
  "justfile",
  "license",
  "makefile",
  "readme",
])

const ignoredFileNames = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "yarn.lock",
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

const hashContent = (content: string): string =>
  createHash("sha256").update(content).digest("hex")

const meaningfulLinePattern = /[^\s\p{P}]/u

const isMeaningfulLine = (line: string): boolean =>
  meaningfulLinePattern.test(line)

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

  if (ignoredFileNames.has(fileName)) {
    return false
  }

  if (/\.min\.(?:css|js)$/i.test(fileName)) {
    return false
  }

  if (fileName.endsWith(".map")) {
    return false
  }

  if (allowedBareFileNames.has(fileName)) {
    return true
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
}) => {
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
    const chunkContent = chunkLines.join("\n")

    out.push({
      path: normalizedPath,
      startLine: start + 1,
      endLine: end,
      contentHash: hashContent(chunkContent),
      content: chunkContent,
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

    const chunkCodebase: CodeChunker["Service"]["chunkCodebase"] =
      Effect.fnUntraced(function* (options) {
        const root = pathService.resolve(options.root)
        const files = yield* listFiles({
          root,
          ...(options.maxFileSize === undefined
            ? {}
            : { maxFileSize: options.maxFileSize }),
        })

        return Stream.fromArray(files).pipe(
          Stream.flatMap(
            (path) => {
              const absolutePath = pathService.resolve(root, path)
              return pipe(
                fs.readFileString(absolutePath),
                Effect.map((content) =>
                  chunkFileContent(path, content, options),
                ),
                Effect.catch(() => Effect.succeed([])),
                Stream.fromArrayEffect,
              )
            },
            { concurrency: 5 },
          ),
        )
      }, Stream.unwrap)

    return CodeChunker.of({
      listFiles,
      chunkCodebase,
    })
  }),
)

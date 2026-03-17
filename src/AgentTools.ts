/**
 * @since 1.0.0
 */
import * as Glob from "glob"
import { parsePatch, patchChunks } from "./ApplyPatch.ts"
import * as ExaSearch from "./ExaSearch.ts"
import * as WebToMarkdown from "./WebToMarkdown.ts"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import * as ServiceMap from "effect/ServiceMap"
import * as Effect from "effect/Effect"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import * as Tool from "effect/unstable/ai/Tool"
import * as Schema from "effect/Schema"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as Stream from "effect/Stream"
import { pipe } from "effect/Function"
import * as Array from "effect/Array"
import * as Data from "effect/Data"
import * as Layer from "effect/Layer"
import * as SemanticSearch from "./SemanticSearch.ts"

/**
 * @since 1.0.0
 * @category Context
 */
export class CurrentDirectory extends ServiceMap.Service<
  CurrentDirectory,
  string
>()("clanka/AgentTools/CurrentDirectory") {}

/**
 * @since 1.0.0
 * @category Context
 */
export class TaskCompleter extends ServiceMap.Service<
  TaskCompleter,
  (output: string) => Effect.Effect<void>
>()("clanka/AgentTools/TaskCompleter") {}

/**
 * @since 1.0.0
 * @category Context
 */
export class SubagentExecutor extends ServiceMap.Service<
  SubagentExecutor,
  (prompt: string) => Effect.Effect<string>
>()("clanka/AgentTools/SubagentExecutor") {}

/**
 * @since 1.0.0
 * @category Context
 */
export const makeContextNoop = (cwd?: string) =>
  SubagentExecutor.serviceMap(() => Effect.die("Not implemented")).pipe(
    ServiceMap.add(CurrentDirectory, cwd ?? "/"),
    ServiceMap.add(TaskCompleter, () => Effect.void),
  )

/**
 * @since 1.0.0
 * @category Toolkit
 */
export const AgentTools = Toolkit.make(
  Tool.make("readFile", {
    description:
      "Read a file and optionally filter the lines to return. Returns null if the file doesn't exist.",
    parameters: Schema.Struct({
      path: Schema.String,
      startLine: Schema.optional(Schema.Number),
      endLine: Schema.optional(Schema.Number),
    }),
    success: Schema.NullOr(Schema.String),
    dependencies: [CurrentDirectory],
  }),
  Tool.make("rg", {
    description: "Search for a pattern in files using ripgrep",
    parameters: Schema.Struct({
      pattern: Schema.String,
      glob: Schema.optional(Schema.String).annotate({
        documentation: "--glob",
      }),
      filesOnly: Schema.optional(Schema.Boolean).annotate({
        documentation: "Only return file paths. --files-with-matches",
      }),
      maxLines: Schema.optional(Schema.Finite).annotate({
        documentation:
          "The total maximum number of lines to return across all files (default: 500)",
      }),
    }),
    success: Schema.String,
    dependencies: [CurrentDirectory],
  }),
  Tool.make("delegate", {
    description:
      "Delegate a task to another software engineer / sub-agent. Returns the result of the task.",
    parameters: Schema.String.annotate({
      identifier: "task",
    }),
    success: Schema.String,
    dependencies: [SubagentExecutor],
  }),
  Tool.make("glob", {
    description: "Find files matching a glob pattern.",
    parameters: Schema.String.annotate({
      identifier: "pattern",
    }),
    success: Schema.Array(Schema.String),
    dependencies: [CurrentDirectory],
  }),
  Tool.make("bash", {
    description: "Run a bash command and return the output",
    parameters: Schema.Struct({
      command: Schema.String,
      timeoutMs: Schema.optional(Schema.Finite).annotate({
        documentation: "Timeout in ms (default: 120000)",
      }),
    }).annotate({
      identifier: "command",
    }),
    success: Schema.String,
    dependencies: [CurrentDirectory],
  }),
  Tool.make("writeFile", {
    description:
      "Write content to a file, creating parent directories if needed. PREFER USING applyPatch to update existing files.",
    parameters: Schema.Struct({
      path: Schema.String,
      content: Schema.String,
    }),
    dependencies: [CurrentDirectory],
  }),
  Tool.make("applyPatch", {
    description:
      "Apply a git diff / unified diff patch, or a wrapped patch, across one or more files.",
    parameters: Schema.String.annotate({
      identifier: "patch",
    }),
    success: Schema.String,
    dependencies: [CurrentDirectory],
  }),
  Tool.make("removeFile", {
    description: "Remove a file.",
    parameters: Schema.String.annotate({
      identifier: "path",
    }),
    dependencies: [CurrentDirectory],
  }),
  Tool.make("renameFile", {
    description:
      "Rename or move a file, creating parent directories if needed.",
    parameters: Schema.Struct({
      from: Schema.String,
      to: Schema.String,
    }),
    dependencies: [CurrentDirectory],
  }),
  Tool.make("mkdir", {
    description: "Make a directory, creating parent directories if needed.",
    parameters: Schema.String.annotate({
      identifier: "path",
    }),
    dependencies: [CurrentDirectory],
  }),
  Tool.make("ls", {
    description: "List the contents of a directory",
    parameters: Schema.String.annotate({
      identifier: "directory",
    }),
    success: Schema.Array(Schema.String),
    dependencies: [CurrentDirectory],
  }),
  Tool.make("gh", {
    description: "Use the GitHub CLI to run a command and return the output",
    parameters: Schema.Array(Schema.String).annotate({
      identifier: "args",
    }),
    success: Schema.String,
    dependencies: [CurrentDirectory],
  }),
  Tool.make("webSearch", {
    description: "Search the web for recent information.",
    parameters: ExaSearch.ExaSearchOptions,
    success: Schema.String,
  }),
  Tool.make("fetchMarkdown", {
    description: "Fetch a web page and convert it to markdown.",
    parameters: Schema.String.annotate({
      identifier: "url",
    }),
    success: Schema.String,
  }),
  Tool.make("sleep", {
    description: "Sleep for a specified number of milliseconds",
    parameters: Schema.Finite.annotate({
      identifier: "ms",
    }),
  }),
  Tool.make("taskComplete", {
    description:
      "Only call this when the task is fully complete and you have a final output message to send.",
    parameters: Schema.String.annotate({
      identifier: "output",
    }),
    dependencies: [TaskCompleter],
  }),
)

const SearchTool = Toolkit.make(
  Tool.make("search", {
    description: "Semantic code search",
    parameters: Schema.Struct({
      query: Schema.String,
      limit: Schema.optional(Schema.Finite).annotate({
        documentation: "Number of results (defaults to 5, max 10)",
      }),
    }),
    success: Schema.String,
    dependencies: [SemanticSearch.SemanticSearch],
  }),
)

/**
 * @since 1.0.0
 * @category Toolkit
 */
export const AgentToolsWithSearch = Toolkit.merge(SearchTool, AgentTools)

/**
 * @since 1.0.0
 * @category Toolkit
 */
export const AgentToolHandlersNoDeps = AgentToolsWithSearch.toLayer(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const webSearch = yield* ExaSearch.ExaSearch
    const fetchMarkdown = yield* WebToMarkdown.WebToMarkdown

    const execute = Effect.fn(function* (command: ChildProcess.Command) {
      const handle = yield* spawner.spawn(command)
      return yield* handle.all.pipe(
        Stream.decodeText,
        Stream.mkString,
        Effect.flatMap(
          Effect.fnUntraced(function* (output) {
            const exitCode = yield* handle.exitCode
            if (exitCode === 0) return output
            return yield* Effect.die(
              new Error(`Command failed with exit code ${exitCode}: ${output}`),
            )
          }),
        ),
      )
    }, Effect.scoped)

    return AgentToolsWithSearch.of({
      readFile: Effect.fn("AgentTools.readFile")(function* (options) {
        yield* Effect.logInfo(`Calling "readFile"`).pipe(
          Effect.annotateLogs(options),
        )
        const cwd = yield* CurrentDirectory
        let stream = pipe(
          fs.stream(pathService.resolve(cwd, options.path)),
          Stream.decodeText,
          Stream.splitLines,
        )
        if (options.startLine) {
          stream = Stream.drop(stream, options.startLine - 1)
        }
        if (options.endLine) {
          stream = Stream.take(
            stream,
            options.endLine - (options.startLine ?? 1) + 1,
          )
        }
        return yield* Stream.runCollect(stream).pipe(
          Effect.map(Array.join("\n")),
          Effect.catchReason("PlatformError", "NotFound", () =>
            Effect.succeed(null),
          ),
          Effect.orDie,
        )
      }),
      writeFile: Effect.fn("AgentTools.writeFile")(function* (options) {
        yield* Effect.logInfo(`Calling "writeFile"`).pipe(
          Effect.annotateLogs({ path: options.path }),
        )
        const cwd = yield* CurrentDirectory
        const path = pathService.resolve(cwd, options.path)
        yield* fs.makeDirectory(pathService.dirname(path), {
          recursive: true,
        })
        yield* fs.writeFileString(path, options.content)
        yield* SemanticSearch.maybeReindex
      }, Effect.orDie),
      removeFile: Effect.fn("AgentTools.removeFile")(function* (path) {
        yield* Effect.logInfo(`Calling "removeFile"`).pipe(
          Effect.annotateLogs({ path }),
        )
        const cwd = yield* CurrentDirectory
        return yield* fs.remove(pathService.resolve(cwd, path), { force: true })
      }, Effect.orDie),
      renameFile: Effect.fn("AgentTools.renameFile")(function* (options) {
        yield* Effect.logInfo(`Calling "renameFile"`).pipe(
          Effect.annotateLogs(options),
        )
        const cwd = yield* CurrentDirectory
        const from = pathService.resolve(cwd, options.from)
        const to = pathService.resolve(cwd, options.to)
        yield* fs.makeDirectory(pathService.dirname(to), {
          recursive: true,
        })
        return yield* fs.rename(from, to)
      }, Effect.orDie),
      mkdir: Effect.fn("AgentTools.mkdir")(function* (path) {
        yield* Effect.logInfo(`Calling "mkdir"`).pipe(
          Effect.annotateLogs({ path }),
        )
        const cwd = yield* CurrentDirectory
        return yield* fs.makeDirectory(pathService.resolve(cwd, path), {
          recursive: true,
        })
      }, Effect.orDie),
      ls: Effect.fn("AgentTools.ls")(function* (path) {
        yield* Effect.logInfo(`Calling "ls"`).pipe(
          Effect.annotateLogs({ path }),
        )
        const cwd = yield* CurrentDirectory
        return yield* fs
          .readDirectory(pathService.resolve(cwd, path))
          .pipe(Effect.orDie)
      }),
      search: Effect.fn("AgentTools.search")(function* (options) {
        yield* Effect.logInfo(`Calling "search"`).pipe(
          Effect.annotateLogs(options),
        )
        const ss = yield* SemanticSearch.SemanticSearch
        return yield* ss.search({
          query: options.query,
          limit: Math.min(10, options.limit ?? 5),
        })
      }),
      rg: Effect.fn("AgentTools.rg")(function* (options) {
        yield* Effect.logInfo(`Calling "rg"`).pipe(Effect.annotateLogs(options))
        const cwd = yield* CurrentDirectory
        const args = [
          "--max-filesize=1M",
          "--heading",
          "--line-number",
          "--max-columns=300",
        ]
        if (options.filesOnly) {
          args.push("--files-with-matches")
        }
        if (options.glob) {
          args.push("--glob", options.glob)
          if (!options.glob.startsWith("*")) {
            args.push("-uu")
          }
        }
        args.push(options.pattern)
        let stream = spawner.streamLines(
          ChildProcess.make("rg", args, {
            cwd,
            stdin: "ignore",
          }),
        )
        stream = Stream.take(stream, options.maxLines ?? 500)
        return yield* Stream.runCollect(stream).pipe(
          Effect.map(Array.join("\n")),
          Effect.orDie,
        )
      }),
      glob: Effect.fn("AgentTools.glob")(function* (pattern) {
        yield* Effect.logInfo(`Calling "glob"`).pipe(
          Effect.annotateLogs({ pattern }),
        )
        const cwd = yield* CurrentDirectory
        return yield* Effect.promise(() => Glob.glob(pattern, { cwd }))
      }),
      bash: Effect.fn("AgentTools.bash")(function* (options) {
        const timeoutMs = options.timeoutMs ?? 120_000
        yield* Effect.logInfo(`Calling "bash"`).pipe(
          Effect.annotateLogs({
            ...options,
            timeoutMs,
          }),
        )
        const cwd = yield* CurrentDirectory
        const cmd = ChildProcess.make("bash", ["-c", options.command], {
          cwd,
          stdin: "ignore",
        })
        return yield* execute(cmd).pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            onTimeout: () =>
              Effect.die(new Error(`Command timed out after ${timeoutMs}ms`)),
          }),
        )
      }, Effect.orDie),
      gh: Effect.fn("AgentTools.gh")(function* (args) {
        yield* Effect.logInfo(`Calling "gh"`).pipe(
          Effect.annotateLogs({ args }),
        )
        const cwd = yield* CurrentDirectory
        const cmd = ChildProcess.make("gh", args, {
          cwd,
          stdin: "ignore",
        })
        return yield* execute(cmd)
      }, Effect.orDie),
      webSearch: Effect.fn("AgentTools.webSearch")(function* (options) {
        yield* Effect.logInfo(`Calling "webSearch"`).pipe(
          Effect.annotateLogs(options),
        )
        return yield* webSearch.search(options)
      }, Effect.orDie),
      fetchMarkdown: Effect.fn("AgentTools.fetchMarkdown")(function* (url) {
        yield* Effect.logInfo(`Calling "fetchMarkdown"`).pipe(
          Effect.annotateLogs({ url }),
        )
        return yield* fetchMarkdown.convertUrl(url)
      }, Effect.orDie),
      sleep: Effect.fn("AgentTools.sleep")(function* (ms) {
        yield* Effect.logInfo(`Calling "sleep" for ${ms}ms`)
        return yield* Effect.sleep(ms)
      }),
      applyPatch: Effect.fn("AgentTools.applyPatch")(function* (patchText) {
        yield* Effect.logInfo(`Calling "applyPatch"`)
        const cwd = yield* CurrentDirectory
        const fail = (path: string, reason: "delete" | "update") =>
          Effect.fail(
            new ApplyPatchError({
              message: `verification failed: Failed to read file to ${reason}: ${path}`,
            }),
          )
        const state = new Map<string, string | null>()
        const steps = [] as Array<
          | {
              readonly type: "add" | "update"
              readonly path: string
              readonly next: string
            }
          | {
              readonly type: "move"
              readonly path: string
              readonly movePath: string
              readonly next: string
            }
          | {
              readonly type: "delete"
              readonly path: string
            }
        >
        const out = [] as Array<string>
        const rel = (path: string) =>
          pathService.relative(cwd, path).replaceAll("\\", "/")
        const load = Effect.fn("AgentTools.applyPatch.load")(function* (
          path: string,
          reason: "delete" | "update",
        ) {
          if (state.has(path)) {
            const input = state.get(path)
            if (input === null) {
              return yield* fail(path, reason)
            }
            return input!
          }

          const input = yield* fs.readFileString(path)
          state.set(path, input)
          return input
        })

        for (const patch of parsePatch(patchText)) {
          const path = pathService.resolve(cwd, patch.path)
          switch (patch.type) {
            case "add": {
              const next =
                patch.content.length === 0 || patch.content.endsWith("\n")
                  ? patch.content
                  : `${patch.content}\n`
              state.set(path, next)
              steps.push({
                type: "add",
                path,
                next,
              })
              out.push(`A ${rel(path)}`)
              break
            }
            case "delete": {
              yield* load(path, "delete")
              state.set(path, null)
              steps.push({
                type: "delete",
                path,
              })
              out.push(`D ${rel(path)}`)
              break
            }
            case "update": {
              const input = yield* load(path, "update")
              const next = patchChunks(path, input, patch.chunks)
              const movePath =
                patch.movePath === undefined
                  ? undefined
                  : pathService.resolve(cwd, patch.movePath)

              if (movePath === undefined || movePath === path) {
                state.set(path, next)
                steps.push({
                  type: "update",
                  path,
                  next,
                })
                out.push(`M ${rel(path)}`)
                break
              }

              state.set(path, null)
              state.set(movePath, next)
              steps.push({
                type: "move",
                path,
                movePath,
                next,
              })
              out.push(`M ${rel(movePath)}`)
              break
            }
          }
        }

        for (const step of steps) {
          switch (step.type) {
            case "add":
            case "update": {
              yield* fs.makeDirectory(pathService.dirname(step.path), {
                recursive: true,
              })
              yield* fs.writeFileString(step.path, step.next)
              break
            }
            case "move": {
              yield* fs.makeDirectory(pathService.dirname(step.movePath), {
                recursive: true,
              })
              yield* fs.writeFileString(step.movePath, step.next)
              yield* fs.remove(step.path)
              break
            }
            case "delete": {
              yield* fs.remove(step.path)
              break
            }
          }
        }

        yield* SemanticSearch.maybeReindex

        return `Success. Updated the following files:\n${out.join("\n")}`
      }, Effect.orDie),
      delegate: Effect.fn("AgentTools.delegate")(function* (prompt) {
        yield* Effect.logInfo(`Calling "delegate"`)
        const spawn = yield* SubagentExecutor
        return yield* spawn(`You have been asked using the "delegate" function to complete the following task. Try to avoid using the "delegate" function yourself unless strictly necessary:

${prompt}`)
      }, Effect.orDie),
      taskComplete: Effect.fn("AgentTools.taskComplete")(function* (message) {
        const deferred = yield* TaskCompleter
        yield* deferred(message)
      }),
    })
  }),
)

/**
 * @since 1.0.0
 * @category Layers
 */
export const AgentToolHandlers: Layer.Layer<
  Tool.HandlersFor<typeof AgentToolsWithSearch.tools>,
  never,
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
> = AgentToolHandlersNoDeps.pipe(
  Layer.provide([ExaSearch.layer, WebToMarkdown.layer]),
)

/**
 * @since 1.0.0
 * @category Layers
 */
export const AgentToolHandlersTest = AgentToolHandlersNoDeps.pipe(
  Layer.provide([
    Layer.mock(ExaSearch.ExaSearch)({}),
    Layer.mock(WebToMarkdown.WebToMarkdown)({}),
  ]),
)

class ApplyPatchError extends Data.TaggedClass("ApplyPatchError")<{
  readonly message: string
}> {}

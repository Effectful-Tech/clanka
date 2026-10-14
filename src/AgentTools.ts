/**
 * @since 1.0.0
 */
/** @effect-diagnostics schemaNumber:off */
import { parsePatch, patchChunks } from "./ApplyPatch.ts"
import * as ExaSearch from "./ExaSearch.ts"
import * as WebToMarkdown from "./WebToMarkdown.ts"
import type * as HttpClient from "effect/http/HttpClient"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Toolkit from "effect/ai/Toolkit"
import * as Tool from "effect/ai/Tool"
import * as Schema from "effect/Schema"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/process/ChildProcess"
import * as Stream from "effect/Stream"
import { pipe } from "effect/Function"
import * as Array from "effect/Array"
import * as Data from "effect/Data"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SemanticSearch from "./SemanticSearch/Service.ts"
import * as Image from "./Image.ts"

/**
 * @since 1.0.0
 * @category Context
 */
export class CurrentDirectory extends Context.Service<
  CurrentDirectory,
  string
>()("clanka/AgentTools/CurrentDirectory") {}

/**
 * @since 1.0.0
 * @category Context
 */
export class DirectoryChanger extends Context.Service<
  DirectoryChanger,
  (directory: string) => Effect.Effect<string>
>()("clanka/AgentTools/DirectoryChanger") {}

/**
 * @since 1.0.0
 * @category Context
 */
export class TaskCompleter extends Context.Service<
  TaskCompleter,
  (output: string) => Effect.Effect<void, string>
>()("clanka/AgentTools/TaskCompleter") {}

/**
 * @since 1.0.0
 * @category Models
 */
export const SubagentStatus = Schema.Literals([
  "completed",
  "running",
  "failed",
  "cancelled",
])

/**
 * @since 1.0.0
 * @category Models
 */
export type SubagentStatus = typeof SubagentStatus.Type

/**
 * @since 1.0.0
 * @category Models
 */
export const SubagentResult = Schema.Struct({
  id: Schema.String,
  status: SubagentStatus,
  output: Schema.optional(Schema.String),
})

/**
 * @since 1.0.0
 * @category Models
 */
export type SubagentResult = typeof SubagentResult.Type

/**
 * @since 1.0.0
 * @category Models
 */
export const DelegateResult = Schema.Struct({
  ...SubagentResult.fields,
  status: Schema.Literals(["completed", "running"]),
})

/**
 * @since 1.0.0
 * @category Models
 */
export type DelegateResult = typeof DelegateResult.Type

/**
 * @since 1.0.0
 * @category Models
 */
export const SubagentInfo = Schema.Struct({
  id: Schema.String,
  status: SubagentStatus,
  prompt: Schema.String,
})

/**
 * @since 1.0.0
 * @category Models
 */
export type SubagentInfo = typeof SubagentInfo.Type

/**
 * Manages the sub-agents of one agent. Every function only sees the agents
 * spawned by that agent.
 *
 * @since 1.0.0
 * @category Models
 */
export interface Subagents {
  /**
   * Start a sub-agent. In the foreground it resolves once the agent has
   * finished, and dies if the agent failed. In the background it resolves
   * straight away with `status: "running"`.
   */
  readonly delegate: (options: {
    readonly prompt: string
    readonly background: boolean
  }) => Effect.Effect<DelegateResult>
  /**
   * Wait for the listed agents, or all of them when `ids` is undefined.
   * Failures are returned as results, not raised.
   */
  readonly waitAgents: (
    ids: ReadonlyArray<string> | undefined,
  ) => Effect.Effect<ReadonlyArray<SubagentResult>, string>
  /**
   * Steer a running agent, or start a new turn on a finished one.
   */
  readonly messageAgent: (options: {
    readonly id: string
    readonly message: string
  }) => Effect.Effect<SubagentResult, string>
  /**
   * Interrupt an agent and everything it spawned.
   */
  readonly stopAgent: (id: string) => Effect.Effect<SubagentResult, string>
  readonly listAgents: Effect.Effect<ReadonlyArray<SubagentInfo>>
}

/**
 * @since 1.0.0
 * @category Context
 */
export class SubagentExecutor extends Context.Service<
  SubagentExecutor,
  Subagents
>()("clanka/AgentTools/SubagentExecutor") {}

/**
 * A `Subagents` implementation for contexts that cannot spawn agents.
 *
 * @since 1.0.0
 * @category Context
 */
export const subagentsUnavailable: Subagents = {
  delegate: () => Effect.die(new Error("Sub-agents are not available here")),
  waitAgents: () => Effect.fail("Sub-agents are not available here"),
  messageAgent: () => Effect.fail("Sub-agents are not available here"),
  stopAgent: () => Effect.fail("Sub-agents are not available here"),
  listAgents: Effect.succeed([]),
}

/**
 * An image read by `readFile`, handed to the Agent so it can be spliced onto
 * the Prompt for the next model turn.
 *
 * @since 1.0.0
 * @category Models
 */
export interface ImageAttachment {
  readonly fileName: string
  readonly mediaType: Image.ImageMediaType
  readonly data: Uint8Array
}

/**
 * @since 1.0.0
 * @category Context
 */
export class ImageAttacher extends Context.Service<
  ImageAttacher,
  (image: ImageAttachment) => Effect.Effect<void>
>()("clanka/AgentTools/ImageAttacher") {}

/**
 * The `bash` timeout when the caller sets none.
 *
 * @since 1.0.0
 * @category Context
 */
export const defaultBashTimeout: Duration.Duration = Duration.minutes(10)

/**
 * The limits the `bash` and `gh` handlers apply to a single command. The
 * executor sets them from its `limits` option.
 *
 * @since 1.0.0
 * @category Context
 */
export class CommandLimits extends Context.Reference<{
  /**
   * The longest a `bash` or `gh` command may run, as set by the caller.
   * Unset, `bash` uses `defaultBashTimeout` and `gh` has no limit.
   */
  readonly timeout: Duration.Duration | undefined
  /** The most characters of output held per command. */
  readonly outputChars: number | undefined
}>("clanka/AgentTools/CommandLimits", {
  defaultValue: () => ({
    timeout: undefined,
    outputChars: undefined,
  }),
}) {}

/**
 * The `bash` tool, with a description that states the timeout that applies.
 *
 * @since 1.0.0
 * @category Toolkit
 */
export const makeBashTool = (timeout: Duration.Duration) =>
  Tool.make("bash", {
    description: "Run a bash command and return the output",
    parameters: Schema.Struct({
      command: Schema.String,
      timeoutMs: Schema.optional(Schema.Finite).annotate({
        documentation: `Timeout in ms (default and max: ${Duration.toMillis(timeout)})`,
      }),
    }).annotate({
      identifier: "command",
    }),
    success: Schema.String,
    dependencies: [CurrentDirectory],
  })

const globNamesDirectory = (glob: string) =>
  glob
    .split("/")
    .slice(0, -1)
    .some((segment) => segment.length > 0 && !/[*?[\]{}]/.test(segment))

/**
 * @since 1.0.0
 * @category Context
 */
export const makeContextNoop = (cwd?: string) =>
  SubagentExecutor.context(subagentsUnavailable).pipe(
    Context.add(CurrentDirectory, cwd ?? "/"),
    Context.add(DirectoryChanger, () => Effect.die("Not implemented")),
    Context.add(TaskCompleter, () => Effect.void),
    Context.add(ImageAttacher, () => Effect.void),
  )

/**
 * @since 1.0.0
 * @category Toolkit
 */
export const AgentTools = Toolkit.make(
  Tool.make("changeDirectory", {
    description:
      "Change the executor's working directory to an existing directory and return its absolute path. Relative paths resolve from the current directory without shell expansion. Await this before dependent tools. The change persists across scripts and is shared with delegates using this executor. Startup AGENTS.md, skills, and the semantic-search index root remain fixed. Navigation does not survive a session reload.",
    parameters: Schema.String.annotate({ identifier: "directory" }),
    success: Schema.String,
    dependencies: [DirectoryChanger],
  }),
  Tool.make("readFile", {
    description:
      "Read a file and optionally filter the lines to return. Returns null if the file doesn't exist. For png/jpeg/gif/webp files the image itself is attached to your next turn and a short marker is returned instead of the bytes; line ranges are not allowed on images.",
    parameters: Schema.Struct({
      path: Schema.String,
      startLine: Schema.optional(Schema.Number),
      endLine: Schema.optional(Schema.Number),
    }),
    success: Schema.NullOr(Schema.String),
    dependencies: [CurrentDirectory, ImageAttacher],
  }),
  Tool.make("rg", {
    description: "Search for a pattern in files using ripgrep",
    parameters: Schema.Struct({
      pattern: Schema.String,
      glob: Schema.optional(Schema.String).annotate({
        documentation: "--glob",
      }),
      filesOnly: Schema.optional(Schema.Boolean).annotate({
        documentation: "Only return file paths --files-with-matches",
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
      'Delegate a task to another software engineer / sub-agent. By default it waits for the sub-agent and returns its output. With `background: true` it returns straight away with status "running"; the sub-agent keeps working while you take more turns, and its result is sent to you as a <subagent> message when it finishes. Keep the returned id to address the agent later.',
    parameters: Schema.Struct({
      prompt: Schema.String,
      background: Schema.optional(Schema.Boolean),
    }),
    success: DelegateResult,
    failure: Schema.String,
    dependencies: [SubagentExecutor],
  }),
  Tool.make("waitAgents", {
    description:
      'Wait until the given sub-agents have finished, or all of your sub-agents when no ids are passed. A failed agent is returned with status "failed" and its error as the output; it does not throw.',
    parameters: Schema.UndefinedOr(Schema.Array(Schema.String)).annotate({
      identifier: "ids",
    }),
    success: Schema.Array(SubagentResult),
    failure: Schema.String,
    dependencies: [SubagentExecutor],
  }),
  Tool.make("messageAgent", {
    description:
      "Send a message to one of your sub-agents. A running agent receives it as steering; a finished agent starts a new turn on top of its previous conversation. Returns straight away; the result is sent to you as a <subagent> message.",
    parameters: Schema.Struct({
      id: Schema.String,
      message: Schema.String,
    }),
    success: SubagentResult,
    failure: Schema.String,
    dependencies: [SubagentExecutor],
  }),
  Tool.make("stopAgent", {
    description:
      "Stop one of your sub-agents and every agent it started. Returns its final status.",
    parameters: Schema.String.annotate({
      identifier: "id",
    }),
    success: SubagentResult,
    failure: Schema.String,
    dependencies: [SubagentExecutor],
  }),
  Tool.make("listAgents", {
    description:
      "List the sub-agents you have started in this run, with their status.",
    parameters: Schema.Void,
    success: Schema.Array(SubagentInfo),
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
  Tool.make("gh", {
    description:
      "Use the GitHub CLI to run a command - use this instead of the bash tool.",
    parameters: Schema.Array(Schema.String).annotate({
      identifier: "args",
    }),
    success: Schema.String,
    dependencies: [CurrentDirectory],
  }),
  makeBashTool(defaultBashTimeout),
  Tool.make("applyPatch", {
    description:
      "Add, update or remove multiple files with a git diff / unified diff / wrapped patch.",
    parameters: Schema.String.annotate({
      identifier: "patch",
    }),
    success: Schema.String,
    dependencies: [CurrentDirectory],
  }),
  Tool.make("writeFile", {
    description:
      "Write content to a file, creating parent directories if needed. Prefer applyPatch to update existing files.",
    parameters: Schema.Struct({
      path: Schema.String,
      content: Schema.String,
    }),
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
  Tool.make("ls", {
    description: "List the contents of a directory",
    parameters: Schema.String.annotate({
      identifier: "directory",
    }),
    success: Schema.Array(Schema.String),
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
    failure: Schema.String,
  }),
)

const SearchTool = Toolkit.make(
  Tool.make("search", {
    description:
      "Semantic code search - you just need to describe what you are looking for",
    parameters: Schema.String.annotate({
      identifier: "query",
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
    const execute = Effect.fn(
      function* (
        command: ChildProcess.Command,
        _timeout: Duration.Duration | undefined,
      ) {
        const { outputChars } = yield* CommandLimits
        const handle = yield* spawner.spawn(command)
        return yield* handle.all.pipe(
          Stream.decodeText,
          outputChars === undefined
            ? Stream.mkString
            : collectBounded(outputChars),
          Effect.flatMap(
            Effect.fnUntraced(function* (output) {
              const exitCode = yield* handle.exitCode
              if (exitCode === 0) return output
              return yield* Effect.die(
                new Error(
                  `Command failed with exit code ${exitCode}: ${output}`,
                ),
              )
            }),
          ),
        )
      },
      (effect, _command, timeout) =>
        timeout === undefined
          ? effect
          : Effect.timeoutOrElse(effect, {
              duration: timeout,
              orElse: () =>
                Effect.die(
                  new Error(
                    `Command timed out after ${Duration.toMillis(timeout)}ms`,
                  ),
                ),
            }),
      Effect.scoped,
    )

    /**
     * Image branch of `readFile`: the bytes go to the `ImageAttacher` for
     * the next model turn and the script only sees a marker.
     */
    const readImage = Effect.fnUntraced(function* (
      path: string,
      extensionType: Image.ImageMediaType,
      options: {
        readonly startLine?: number | undefined
        readonly endLine?: number | undefined
      },
    ) {
      if (options.startLine !== undefined || options.endLine !== undefined) {
        return yield* Effect.die(
          new Error(
            `startLine / endLine are not supported for images: ${path}`,
          ),
        )
      }
      const bytes = yield* Image.readBoundedFile(fs, path).pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.succeed(null),
        ),
        Effect.orDie,
      )
      if (bytes === null) return null
      // The extension picks the branch; the magic bytes pick the real type.
      const mediaType = Option.getOrElse(
        Image.mediaTypeFromBytes(bytes),
        () => extensionType,
      )
      const prepared = yield* Image.prepare({ data: bytes, mediaType }).pipe(
        Effect.mapError((error) => new Error(`${error.message} (${path})`)),
        Effect.orDie,
      )
      const fileName = pathService.basename(path)
      const attach = yield* ImageAttacher
      yield* attach({
        fileName,
        mediaType: prepared.mediaType,
        data: prepared.data,
      })
      return `Image attached: ${fileName}`
    })

    return AgentToolsWithSearch.of({
      changeDirectory: Effect.fn("AgentTools.changeDirectory")(
        function* (directory) {
          yield* Effect.logInfo(`Calling "changeDirectory"`).pipe(
            Effect.annotateLogs({ directory }),
          )
          const changeDirectory = yield* DirectoryChanger
          return yield* changeDirectory(directory)
        },
      ),
      readFile: Effect.fn("AgentTools.readFile")(function* (options) {
        yield* Effect.logInfo(`Calling "readFile"`).pipe(
          Effect.annotateLogs(options),
        )
        const cwd = yield* CurrentDirectory
        const path = pathService.resolve(cwd, options.path)
        const imageType = Image.mediaTypeFromPath(path)
        if (Option.isSome(imageType)) {
          return yield* readImage(path, imageType.value, options)
        }
        let stream = pipe(fs.stream(path), Stream.decodeText, Stream.splitLines)
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
        yield* SemanticSearch.maybeUpdateFile(path)
      }, Effect.orDie),
      removeFile: Effect.fn("AgentTools.removeFile")(function* (path) {
        yield* Effect.logInfo(`Calling "removeFile"`).pipe(
          Effect.annotateLogs({ path }),
        )
        const cwd = yield* CurrentDirectory
        const absolutePath = pathService.resolve(cwd, path)
        yield* fs.remove(absolutePath, { force: true })
        yield* SemanticSearch.maybeRemoveFile(absolutePath)
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
        yield* fs.rename(from, to)
        yield* SemanticSearch.maybeRemoveFile(from)
        yield* SemanticSearch.maybeUpdateFile(to)
      }, Effect.orDie),
      ls: Effect.fn("AgentTools.ls")(function* (directory) {
        yield* Effect.logInfo(`Calling "ls"`).pipe(
          Effect.annotateLogs({ directory }),
        )
        const cwd = yield* CurrentDirectory
        return yield* fs
          .readDirectory(pathService.resolve(cwd, directory))
          .pipe(Effect.orDie)
      }),
      search: Effect.fn("AgentTools.search")(function* (query) {
        yield* Effect.logInfo(`Calling "search"`).pipe(
          Effect.annotateLogs({ query }),
        )
        const ss = yield* SemanticSearch.SemanticSearch
        return yield* ss.search({
          query,
          limit: 5,
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
        const searchesIgnoredFiles =
          options.glob !== undefined && !options.glob.startsWith("*")
        if (options.glob) {
          args.push("--glob", options.glob)
          if (searchesIgnoredFiles) {
            args.push("-uu")
          }
        }
        args.push(options.pattern)
        const run = Effect.fnUntraced(function* (args: Array<string>) {
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
        })
        const output = yield* run(args)
        if (
          output.length > 0 ||
          searchesIgnoredFiles ||
          options.glob === undefined ||
          !globNamesDirectory(options.glob)
        ) {
          return output
        }
        return yield* run(args.slice(0, -1).concat("-uu", options.pattern))
      }),
      glob: Effect.fn("AgentTools.glob")(function* (pattern) {
        yield* Effect.logInfo(`Calling "glob"`).pipe(
          Effect.annotateLogs({ pattern }),
        )
        const cwd = yield* CurrentDirectory
        return yield* Effect.promise(() =>
          import("glob").then((Glob) => Glob.glob(pattern, { cwd })),
        )
      }),
      bash: Effect.fn("AgentTools.bash")(function* (options) {
        const limits = yield* CommandLimits
        const maxMs = Duration.toMillis(limits.timeout ?? defaultBashTimeout)
        const timeoutMs = Math.min(options.timeoutMs ?? maxMs, maxMs)
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
        return yield* execute(cmd, Duration.millis(timeoutMs))
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
        const { timeout } = yield* CommandLimits
        return yield* execute(cmd, timeout)
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
        // oxlint-disable-next-line unicorn/consistent-function-scoping
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
        const rel = (path: string) => pathService.relative(cwd, path)
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
              yield* SemanticSearch.maybeUpdateFile(step.path)
              break
            }
            case "move": {
              yield* fs.makeDirectory(pathService.dirname(step.movePath), {
                recursive: true,
              })
              yield* fs.writeFileString(step.movePath, step.next)
              yield* fs.remove(step.path)
              yield* SemanticSearch.maybeRemoveFile(step.path)
              yield* SemanticSearch.maybeUpdateFile(step.movePath)
              break
            }
            case "delete": {
              yield* fs.remove(step.path)
              yield* SemanticSearch.maybeRemoveFile(step.path)
              break
            }
          }
        }

        return `Success. Updated the following files:\n${out.join("\n")}`
      }, Effect.orDie),
      delegate: Effect.fn("AgentTools.delegate")(function* (options: unknown) {
        const { prompt, background = false } = yield* decodeDelegate(options)
        yield* Effect.logInfo(`Calling "delegate"`).pipe(
          Effect.annotateLogs({ background }),
        )
        const subagents = yield* SubagentExecutor
        return yield* subagents.delegate({ prompt, background })
      }),
      waitAgents: Effect.fn("AgentTools.waitAgents")(function* (
        input: unknown,
      ) {
        const ids = yield* decodeWaitAgents(input)
        yield* Effect.logInfo(`Calling "waitAgents"`).pipe(
          Effect.annotateLogs({ ids }),
        )
        const subagents = yield* SubagentExecutor
        return yield* subagents.waitAgents(ids)
      }),
      messageAgent: Effect.fn("AgentTools.messageAgent")(function* (
        input: unknown,
      ) {
        const options = yield* decodeMessageAgent(input)
        yield* Effect.logInfo(`Calling "messageAgent"`).pipe(
          Effect.annotateLogs({ id: options.id }),
        )
        const subagents = yield* SubagentExecutor
        return yield* subagents.messageAgent(options)
      }),
      stopAgent: Effect.fn("AgentTools.stopAgent")(function* (input: unknown) {
        const id = yield* decodeStopAgent(input)
        yield* Effect.logInfo(`Calling "stopAgent"`).pipe(
          Effect.annotateLogs({ id }),
        )
        const subagents = yield* SubagentExecutor
        return yield* subagents.stopAgent(id)
      }),
      listAgents: Effect.fn("AgentTools.listAgents")(function* () {
        yield* Effect.logInfo(`Calling "listAgents"`)
        const subagents = yield* SubagentExecutor
        return yield* subagents.listAgents
      }),
      taskComplete: Effect.fn("AgentTools.taskComplete")(function* (
        message: unknown,
      ) {
        if (typeof message !== "string") {
          return yield* Effect.fail(
            'taskComplete requires a string argument. Pass your final output directly, for example: taskComplete("done").',
          )
        }
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

// Scripts pass tool arguments undecoded. Invalid input fails with a usage
// message the model can act on.
const decodeParams = <S extends Schema.Decoder<unknown>>(
  schema: S,
  usage: string,
) => {
  const decode = Schema.decodeUnknownEffect(schema)
  return (input: unknown) => Effect.mapError(decode(input), () => usage)
}

const decodeDelegate = decodeParams(
  AgentTools.tools.delegate.parametersSchema,
  'delegate requires an options object, for example: delegate({ prompt: "..." }) or delegate({ prompt: "...", background: true }).',
)
const decodeWaitAgents = decodeParams(
  AgentTools.tools.waitAgents.parametersSchema,
  'waitAgents takes an optional array of agent ids, for example: waitAgents(["3", "4"]).',
)
const decodeMessageAgent = decodeParams(
  AgentTools.tools.messageAgent.parametersSchema,
  'messageAgent requires an options object, for example: messageAgent({ id: "3", message: "..." }).',
)
const decodeStopAgent = decodeParams(
  AgentTools.tools.stopAgent.parametersSchema,
  'stopAgent requires an agent id, for example: stopAgent("3").',
)

/**
 * Collects text output keeping at most `maxChars` characters: the start, the
 * end, and a marker in place of the middle. Only the kept text is held in
 * memory while the stream runs.
 */
const collectBounded =
  (maxChars: number) =>
  <E, R>(stream: Stream.Stream<string, E, R>): Effect.Effect<string, E, R> => {
    const headChars = Math.floor(maxChars / 2)
    const tailChars = maxChars - headChars
    let head = ""
    let tail = ""
    let total = 0
    return stream.pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          total += chunk.length
          let rest = chunk
          if (head.length < headChars) {
            const take = headChars - head.length
            head += rest.slice(0, take)
            rest = rest.slice(take)
          }
          if (rest.length > 0 && tailChars > 0) {
            tail = (tail + rest).slice(-tailChars)
          }
        }),
      ),
      Effect.map(() => {
        const omitted = total - head.length - tail.length
        if (omitted <= 0) return head + tail
        return `${head}\n\n[... ${omitted} of ${total} chars omitted from the middle of the output ...]\n\n${tail}`
      }),
    )
  }

class ApplyPatchError extends Data.TaggedClass("ApplyPatchError")<{
  readonly message: string
}> {}

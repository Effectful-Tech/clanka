/**
 * @since 1.0.0
 */
/** @effect-diagnostics schemaNumber:off */
import { parsePatch, patchChunks } from "./ApplyPatch.ts"
import * as ExaSearch from "./ExaSearch.ts"
import * as WebToMarkdown from "./WebToMarkdown.ts"
import type * as HttpClient from "effect/http/HttpClient"
import type * as PlatformError from "effect/PlatformError"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
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
 * What a task is: a background `bash` command or a sub-agent started with
 * `delegate`.
 *
 * @since 1.0.0
 * @category Models
 */
export const TaskKind = Schema.Literals(["bash", "agent"])

/**
 * @since 1.0.0
 * @category Models
 */
export type TaskKind = typeof TaskKind.Type

/**
 * @since 1.0.0
 * @category Models
 */
export const TaskStatus = Schema.Literals([
  "running",
  "completed",
  "failed",
  "stopped",
])

/**
 * @since 1.0.0
 * @category Models
 */
export type TaskStatus = typeof TaskStatus.Type

/**
 * A background `bash` command or a sub-agent, as returned by the task
 * functions. Both kinds share one id space per executor.
 *
 * @since 1.0.0
 * @category Models
 */
export const Task = Schema.Struct({
  id: Schema.String,
  kind: TaskKind,
  status: TaskStatus,
  /** The bash command, or the sub-agent's prompt. */
  description: Schema.String,
  /** Output so far while running; the final output, or the error, once ended. */
  output: Schema.String,
  /** bash only: set when the command exited on its own. */
  exitCode: Schema.optional(Schema.Number),
})

/**
 * @since 1.0.0
 * @category Models
 */
export type Task = typeof Task.Type

/**
 * The sub-agent side of the task functions, for one agent. The executor
 * resolves bash tasks itself and hands agent tasks to these, so every
 * function only receives ids of agents that this agent started.
 *
 * @since 1.0.0
 * @category Models
 */
export interface AgentTasks {
  /**
   * Start a sub-agent under the id the executor allocated. In the foreground
   * it resolves once the agent has finished, and dies if the agent failed.
   * In the background it resolves straight away with `status: "running"`.
   */
  readonly delegate: (options: {
    readonly id: string
    readonly prompt: string
    readonly background: boolean
  }) => Effect.Effect<Task>
  /**
   * The agent's status and output so far. A final status counts as reported.
   */
  readonly taskOutput: (id: string) => Effect.Effect<Task, string>
  /**
   * Wait for the listed agents to end. Failures are returned as tasks, not
   * raised, and count as reported.
   */
  readonly waitTasks: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<Task>, string>
  /**
   * Steer a running agent, or start a new turn on a finished one.
   */
  readonly messageAgent: (options: {
    readonly id: string
    readonly message: string
  }) => Effect.Effect<Task, string>
  /**
   * Interrupt an agent and everything it spawned.
   */
  readonly stopTask: (id: string) => Effect.Effect<Task, string>
  /**
   * The agents this agent started.
   */
  readonly listTasks: Effect.Effect<ReadonlyArray<Task>>
}

/**
 * @since 1.0.0
 * @category Context
 */
export class AgentTaskExecutor extends Context.Service<
  AgentTaskExecutor,
  AgentTasks
>()("clanka/AgentTools/AgentTaskExecutor") {}

/**
 * An `AgentTasks` implementation for contexts that cannot spawn agents.
 *
 * @since 1.0.0
 * @category Context
 */
export const agentTasksUnavailable: AgentTasks = {
  delegate: () => Effect.die(new Error("Sub-agents are not available here")),
  taskOutput: () => Effect.fail("Sub-agents are not available here"),
  waitTasks: () => Effect.fail("Sub-agents are not available here"),
  messageAgent: () => Effect.fail("Sub-agents are not available here"),
  stopTask: () => Effect.fail("Sub-agents are not available here"),
  listTasks: Effect.succeed([]),
}

/**
 * The agent running the current script. Tasks are only visible to the agent
 * that started them; scripts without an agent share the `undefined` owner.
 * The executor sets it from `ExecuteOptions.agentId`.
 *
 * @since 1.0.0
 * @category Context
 */
export class TaskOwner extends Context.Reference<string | undefined>(
  "clanka/AgentTools/TaskOwner",
  { defaultValue: () => undefined },
) {}

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
 * A task that has started, handed to the `TaskWatcher`.
 *
 * @since 1.0.0
 * @category Models
 */
export interface TaskHandle {
  readonly id: string
  readonly kind: TaskKind
  /** Waits for the task to end and succeeds with its final state. */
  readonly await: Effect.Effect<Task>
  /**
   * Marks the task's final state as reported. Succeeds with `false` when it
   * already was: by `stopTask`, `waitTasks`, a `taskOutput` call that
   * returned it, or an earlier `claim`.
   */
  readonly claim: Effect.Effect<boolean>
}

/**
 * Receives every background `bash` task as it starts: those started with
 * `background: true` and those moved to the background at their timeout.
 * The executor sets it from `ExecuteOptions.onTask`.
 *
 * @since 1.0.0
 * @category Context
 */
export class TaskWatcher extends Context.Reference<
  (task: TaskHandle) => Effect.Effect<void>
>("clanka/AgentTools/TaskWatcher", {
  defaultValue: () => () => Effect.void,
}) {}

/**
 * The `bash` timeout when the caller sets none.
 *
 * @since 1.0.0
 * @category Context
 */
export const defaultBashTimeout: Duration.Duration = Duration.minutes(10)

/**
 * The timeout of an MCP tool call when its server sets no `callTimeout`.
 *
 * @since 1.0.0
 * @category Context
 */
export const defaultMcpCallTimeout: Duration.Duration = Duration.minutes(10)

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
    description:
      'Run a bash command and return the output. With `background: true` it returns a running bash task straight away while the command keeps running. A command still running at its timeout is not stopped: it is moved to the background, and the output so far is returned with its task id. Read a task with "taskOutput" and stop it with "stopTask".',
    parameters: Schema.Struct({
      command: Schema.String,
      timeoutMs: Schema.optional(Schema.Finite).annotate({
        documentation: `How long to wait in ms before moving the command to the background (default and max: ${Duration.toMillis(timeout)})`,
      }),
      background: Schema.optional(Schema.Boolean).annotate({
        documentation:
          "Start the command in the background and return its task without waiting",
      }),
    }).annotate({
      identifier: "command",
    }),
    success: Schema.Union([Schema.String, Task]),
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
  AgentTaskExecutor.context(agentTasksUnavailable).pipe(
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
      "Change the executor's working directory to an existing directory and return its absolute path. Relative paths resolve from the current directory without shell expansion. Await this before dependent tools. The change persists across your scripts. A sub-agent starts in your directory at the time it is created, and its changes do not affect yours. AGENTS.md files and skills that apply to the new directory are sent to you after the script ends. The semantic-search index root stays fixed.",
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
      lineNumbers: Schema.optional(Schema.Boolean).annotate({
        documentation:
          "Prefix text lines with their line numbers (default: true)",
      }),
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
      'Delegate a task to another software engineer / sub-agent. By default it waits for the sub-agent and returns its completed task with the output. With `background: true` it returns straight away with status "running"; the sub-agent keeps working while you take more turns, and its result is sent to you when it finishes. Keep the returned id to address the agent later.',
    parameters: Schema.Struct({
      prompt: Schema.String,
      background: Schema.optional(Schema.Boolean),
    }),
    success: Task,
    failure: Schema.String,
    dependencies: [AgentTaskExecutor],
  }),
  Tool.make("messageAgent", {
    description:
      "Send a message to one of your sub-agents. A running agent receives it as steering; a finished agent starts a new turn on top of its previous conversation. Returns straight away; the result is sent to you when the turn ends.",
    parameters: Schema.Struct({
      id: Schema.String,
      message: Schema.String,
    }),
    success: Task,
    failure: Schema.String,
    dependencies: [AgentTaskExecutor],
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
  Tool.make("taskOutput", {
    description:
      "Return the status and output so far of one of your tasks: a background bash command or a sub-agent.",
    parameters: Schema.String.annotate({
      identifier: "id",
    }),
    success: Task,
    failure: Schema.String,
    dependencies: [AgentTaskExecutor],
  }),
  Tool.make("waitTasks", {
    description:
      'Wait until the given tasks have ended and return them. A failed task is returned with status "failed" and its error as the output; it does not throw.',
    parameters: Schema.Array(Schema.String).annotate({
      identifier: "ids",
    }),
    success: Schema.Array(Task),
    failure: Schema.String,
    dependencies: [AgentTaskExecutor],
  }),
  Tool.make("stopTask", {
    description:
      "Stop one of your tasks, and for a sub-agent every agent it started. Returns its final status and output.",
    parameters: Schema.String.annotate({
      identifier: "id",
    }),
    success: Task,
    failure: Schema.String,
    dependencies: [AgentTaskExecutor],
  }),
  Tool.make("listTasks", {
    description: "List the tasks you have started, with their status.",
    parameters: Schema.Void,
    success: Schema.Array(Task),
    dependencies: [AgentTaskExecutor],
  }),
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
      "Write content to a file, creating parent directories if needed.",
    parameters: Schema.Struct({
      path: Schema.String,
      content: Schema.Union([
        Schema.String,
        Schema.Uint8Array.annotate({ identifier: "Uint8Array" }),
      ]),
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
 * A built-in tool a caller can leave out. `taskComplete` always stays.
 *
 * @since 1.0.0
 * @category Toolkit
 */
export type ExcludableTool = Exclude<
  keyof typeof AgentToolsWithSearch.tools,
  "taskComplete"
>

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
    // Commands run in fibers owned by the executor rather than the tool call,
    // so one that is moved to the background outlives the script that
    // started it. Closing the executor stops them all.
    const commandScope = yield* Effect.scope
    const startCommand = Effect.fnUntraced(function* (
      command: ChildProcess.Command,
    ) {
      const { outputChars } = yield* CommandLimits
      const output = makeOutputBuffer(outputChars)
      const fiber = yield* spawner.spawn(command).pipe(
        Effect.flatMap((handle) =>
          handle.all.pipe(
            Stream.decodeText,
            Stream.runForEach((chunk) =>
              Effect.sync(() => output.append(chunk)),
            ),
            Effect.andThen(handle.exitCode),
          ),
        ),
        Effect.scoped,
        Effect.forkIn(commandScope),
      )
      return { fiber, output: output.render }
    })

    // Every task started on this executor, bash and agent alike, so both
    // kinds share one id space. Each is only visible to the agent that
    // started it.
    const tasks = new Map<string, TaskEntry>()
    let nextTaskId = 1
    const registerAgentTask = Effect.fnUntraced(function* () {
      const id = String(nextTaskId++)
      tasks.set(id, { kind: "agent", id, owner: yield* TaskOwner })
      return id
    })
    const addBashTask = Effect.fnUntraced(function* (
      description: string,
      command: Omit<RunningCommand, "reported">,
    ) {
      const id = String(nextTaskId++)
      const entry: BashEntry = {
        kind: "bash",
        id,
        owner: yield* TaskOwner,
        description,
        command: { ...command, reported: false },
      }
      tasks.set(id, entry)
      const watch = yield* TaskWatcher
      yield* watch({
        id,
        kind: "bash",
        await: Fiber.await(entry.command.fiber).pipe(
          Effect.map(() => bashTask(entry)),
        ),
        claim: Effect.sync(() => {
          if (entry.command.reported) return false
          entry.command.reported = true
          return true
        }),
      })
      return entry
    })
    const findTask = Effect.fnUntraced(function* (id: string) {
      const owner = yield* TaskOwner
      const entry = tasks.get(id)
      if (entry === undefined || entry.owner !== owner) {
        return yield* Effect.fail(
          `No task with id ${JSON.stringify(id)}. You can only address tasks you started; call listTasks() to see them.`,
        )
      }
      return entry
    })
    // A command still running at its timeout is stopped, or with
    // `background` handed over as a bash task. A caller that is interrupted first
    // stops it either way.
    const runCommand = Effect.fnUntraced(function* (
      command: ChildProcess.Command,
      timeout: Duration.Duration | undefined,
      onTimeout: "stop" | { readonly background: string },
    ) {
      const running = yield* startCommand(command)
      const awaited = Fiber.await(running.fiber)
      const exit = yield* (
        timeout === undefined
          ? Effect.asSome(awaited)
          : Effect.timeoutOption(awaited, timeout)
      ).pipe(Effect.onInterrupt(() => Fiber.interrupt(running.fiber)))
      if (Option.isNone(exit)) {
        const timeoutMs = Duration.toMillis(timeout!)
        if (onTimeout === "stop") {
          yield* Fiber.interrupt(running.fiber)
          return yield* Effect.die(
            new Error(`Command timed out after ${timeoutMs}ms`),
          )
        }
        const { id } = yield* addBashTask(onTimeout.background, running)
        const output = running.output()
        return `${output}${output === "" || output.endsWith("\n") ? "" : "\n"}[Still running after ${timeoutMs}ms, so it was moved to the background as task ${id}. Use taskOutput("${id}") for its status and output, or stopTask("${id}") to stop it.]`
      }
      const exitCode = yield* exit.value
      const output = running.output()
      if (exitCode === 0) return output
      return yield* Effect.die(
        new Error(`Command failed with exit code ${exitCode}: ${output}`),
      )
    })

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
          Effect.map((lines) =>
            options.lineNumbers === false
              ? lines
              : lines.map(
                  (line, index) =>
                    `${(options.startLine ?? 1) + index}: ${line}`,
                ),
          ),
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
        yield* typeof options.content === "string"
          ? fs.writeFileString(path, options.content)
          : fs.writeFile(path, options.content)
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
        if (options.background === true) {
          const entry = yield* addBashTask(
            options.command,
            yield* startCommand(cmd),
          )
          return bashTask(entry)
        }
        return yield* runCommand(cmd, Duration.millis(timeoutMs), {
          background: options.command,
        })
      }, Effect.orDie),
      taskOutput: Effect.fn("AgentTools.taskOutput")(function* (
        input: unknown,
      ) {
        const id = yield* decodeTaskOutput(input)
        yield* Effect.logInfo(`Calling "taskOutput"`).pipe(
          Effect.annotateLogs({ id }),
        )
        const entry = yield* findTask(id)
        if (entry.kind === "bash") return reportBash(entry)
        const agentTasks = yield* AgentTaskExecutor
        return yield* agentTasks.taskOutput(id)
      }),
      waitTasks: Effect.fn("AgentTools.waitTasks")(function* (input: unknown) {
        const ids = yield* decodeWaitTasks(input)
        yield* Effect.logInfo(`Calling "waitTasks"`).pipe(
          Effect.annotateLogs({ ids }),
        )
        const entries = yield* Effect.forEach(ids, findTask)
        const bashEntries = entries.filter(
          (entry): entry is BashEntry => entry.kind === "bash",
        )
        const agentIds = entries.flatMap((entry) =>
          entry.kind === "agent" ? [entry.id] : [],
        )
        const agentTasks = yield* AgentTaskExecutor
        const [bashTasks, agentResults] = yield* Effect.all(
          [
            Effect.forEach(
              bashEntries,
              (entry) =>
                Fiber.await(entry.command.fiber).pipe(
                  Effect.map(() => reportBash(entry)),
                ),
              { concurrency: "unbounded" },
            ),
            agentIds.length === 0
              ? Effect.succeed([])
              : agentTasks.waitTasks(agentIds),
          ],
          { concurrency: "unbounded" },
        )
        const ended = new Map(
          [...bashTasks, ...agentResults].map((task) => [task.id, task]),
        )
        return ids.map((id) => ended.get(id)!)
      }),
      stopTask: Effect.fn("AgentTools.stopTask")(function* (input: unknown) {
        const id = yield* decodeStopTask(input)
        yield* Effect.logInfo(`Calling "stopTask"`).pipe(
          Effect.annotateLogs({ id }),
        )
        const entry = yield* findTask(id)
        if (entry.kind === "agent") {
          const agentTasks = yield* AgentTaskExecutor
          return yield* agentTasks.stopTask(id)
        }
        yield* Fiber.interrupt(entry.command.fiber)
        return reportBash(entry)
      }),
      listTasks: Effect.fn("AgentTools.listTasks")(function* () {
        yield* Effect.logInfo(`Calling "listTasks"`)
        const owner = yield* TaskOwner
        const bashTasks = Array.Array.from(tasks.values()).flatMap((entry) =>
          entry.kind === "bash" && entry.owner === owner
            ? [bashTask(entry)]
            : [],
        )
        const agentTasks = yield* AgentTaskExecutor
        return [...bashTasks, ...(yield* agentTasks.listTasks)].toSorted(
          (a, b) => Number(a.id) - Number(b.id),
        )
      }),
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
        return yield* runCommand(cmd, timeout, "stop")
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
        const id = yield* registerAgentTask()
        const agentTasks = yield* AgentTaskExecutor
        return yield* agentTasks.delegate({ id, prompt, background })
      }),
      messageAgent: Effect.fn("AgentTools.messageAgent")(function* (
        input: unknown,
      ) {
        const options = yield* decodeMessageAgent(input)
        yield* Effect.logInfo(`Calling "messageAgent"`).pipe(
          Effect.annotateLogs({ id: options.id }),
        )
        const entry = yield* findTask(options.id)
        if (entry.kind === "bash") {
          return yield* Effect.fail(
            `messageAgent only addresses sub-agents, and task ${JSON.stringify(entry.id)} is a bash task. Use taskOutput or stopTask with it instead.`,
          )
        }
        const agentTasks = yield* AgentTaskExecutor
        return yield* agentTasks.messageAgent(options)
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
const decodeMessageAgent = decodeParams(
  AgentTools.tools.messageAgent.parametersSchema,
  'messageAgent requires an options object, for example: messageAgent({ id: "3", message: "..." }).',
)
const decodeTaskOutput = decodeParams(
  AgentTools.tools.taskOutput.parametersSchema,
  'taskOutput requires a task id, for example: taskOutput("1").',
)
const decodeWaitTasks = decodeParams(
  AgentTools.tools.waitTasks.parametersSchema,
  'waitTasks requires an array of task ids, for example: waitTasks(["3", "4"]).',
)
const decodeStopTask = decodeParams(
  AgentTools.tools.stopTask.parametersSchema,
  'stopTask requires a task id, for example: stopTask("1").',
)

interface RunningCommand {
  readonly fiber: Fiber.Fiber<
    ChildProcessSpawner.ExitCode,
    PlatformError.PlatformError
  >
  readonly output: () => string
  /**
   * Whether the final state has been reported, so it is not pushed to the
   * model as well.
   */
  reported: boolean
}

interface BashEntry {
  readonly kind: "bash"
  readonly id: string
  readonly owner: string | undefined
  readonly description: string
  readonly command: RunningCommand
}

/** The executor only records who owns an agent task; the agent tracks it. */
interface AgentEntry {
  readonly kind: "agent"
  readonly id: string
  readonly owner: string | undefined
}

type TaskEntry = BashEntry | AgentEntry

// A bash task's final state, once returned to the script, is not pushed.
const reportBash = (entry: BashEntry): Task => {
  const task = bashTask(entry)
  if (task.status !== "running") entry.command.reported = true
  return task
}

const bashTask = ({ id, description, command }: BashEntry): Task => {
  const exit = command.fiber.pollUnsafe()
  const output = command.output()
  if (exit === undefined) {
    return { id, kind: "bash", status: "running", description, output }
  }
  if (Exit.isSuccess(exit)) {
    return {
      id,
      kind: "bash",
      status: exit.value === 0 ? "completed" : "failed",
      description,
      output,
      exitCode: exit.value,
    }
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return { id, kind: "bash", status: "stopped", description, output }
  }
  return {
    id,
    kind: "bash",
    status: "failed",
    description,
    output: `${output}${output === "" ? "" : "\n"}${Cause.pretty(exit.cause)}`,
  }
}

/**
 * Accumulates text output keeping at most `maxChars` characters: the start,
 * the end, and a marker in place of the middle. Only the kept text is held in
 * memory. Without a limit everything is kept.
 */
const makeOutputBuffer = (maxChars: number | undefined) => {
  const headChars =
    maxChars === undefined ? Number.POSITIVE_INFINITY : Math.floor(maxChars / 2)
  const tailChars = maxChars === undefined ? 0 : maxChars - headChars
  let head = ""
  let tail = ""
  let total = 0
  return {
    append(chunk: string) {
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
    },
    render() {
      const omitted = total - head.length - tail.length
      if (omitted <= 0) return head + tail
      return `${head}\n\n[... ${omitted} of ${total} chars omitted from the middle of the output ...]\n\n${tail}`
    },
  }
}

class ApplyPatchError extends Data.TaggedClass("ApplyPatchError")<{
  readonly message: string
}> {}

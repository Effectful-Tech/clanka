import {
  Array,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Path,
  pipe,
  Schema,
  ServiceMap,
  Stream,
} from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as Glob from "glob"
import * as Rg from "@vscode/ripgrep"
import { NodeServices } from "@effect/platform-node"
import { patchContent } from "./ApplyPatch.ts"

export class CurrentDirectory extends ServiceMap.Service<
  CurrentDirectory,
  string
>()("clanka/AgentTools/CurrentDirectory") {}

export class TaskCompleteDeferred extends ServiceMap.Service<
  TaskCompleteDeferred,
  Deferred.Deferred<string>
>()("clanka/AgentTools/TaskCompleteDeferred") {}

export const AgentTools = Toolkit.make(
  Tool.make("applyPatch", {
    description:
      "Apply a patch to a single file. **Use this for updating files**.",
    parameters: Schema.Struct({
      path: Schema.String,
      patchText: Schema.String.annotate({
        documentation: "Raw @@ hunks or one wrapped update block.",
      }),
    }),
    success: Schema.String,
    dependencies: [CurrentDirectory],
  }),
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
  Tool.make("writeFile", {
    description: "Write content to a file, replacing it if it already exists.",
    parameters: Schema.Struct({
      path: Schema.String,
      content: Schema.String,
    }),
    dependencies: [CurrentDirectory],
  }),
  Tool.make("readdir", {
    description: "List the contents of a directory",
    parameters: Schema.String.annotate({
      identifier: "path",
    }),
    success: Schema.Array(Schema.String),
    dependencies: [CurrentDirectory],
  }),
  Tool.make("rg", {
    description: "Search for a pattern in files using ripgrep.",
    parameters: Schema.Struct({
      pattern: Schema.String,
      glob: Schema.optional(Schema.String).annotate({
        documentation: "--glob",
      }),
      maxLines: Schema.optional(Schema.Finite).annotate({
        documentation:
          "The total maximum number of lines to return across all files (default: 500)",
      }),
    }),
    success: Schema.String,
    dependencies: [CurrentDirectory],
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
    parameters: Schema.String.annotate({
      identifier: "command",
    }),
    success: Schema.String,
    dependencies: [CurrentDirectory],
  }),
  Tool.make("httpGet", {
    description: "Fetch a URL and return its text response.",
    parameters: Schema.String.annotate({
      identifier: "url",
    }),
    success: Schema.String,
  }),
  Tool.make("removeFile", {
    description: "Remove a file at the given path.",
    parameters: Schema.String.annotate({
      identifier: "path",
    }),
    dependencies: [CurrentDirectory],
  }),
  Tool.make("sleep", {
    description: "Sleep for a specified number of milliseconds",
    parameters: Schema.Finite.annotate({
      identifier: "ms",
    }),
  }),
  Tool.make("taskComplete", {
    description:
      "Only call this when you have fully completed the user's task, completely ending the session",
    parameters: Schema.String.annotate({
      identifier: "message",
    }),
    dependencies: [TaskCompleteDeferred],
  }),
)

export const AgentToolHandlers = AgentTools.toLayer(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

    return AgentTools.of({
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
        yield* fs.writeFileString(
          pathService.resolve(cwd, options.path),
          options.content,
        )
      }, Effect.orDie),
      removeFile: Effect.fn("AgentTools.removeFile")(function* (path) {
        yield* Effect.logInfo(`Calling "removeFile"`).pipe(
          Effect.annotateLogs({ path }),
        )
        const cwd = yield* CurrentDirectory
        yield* fs.remove(pathService.resolve(cwd, path))
      }, Effect.orDie),
      readdir: Effect.fn("AgentTools.readdir")(function* (path) {
        yield* Effect.logInfo(`Calling "readdir"`).pipe(
          Effect.annotateLogs({ path }),
        )
        const cwd = yield* CurrentDirectory
        return yield* fs
          .readDirectory(pathService.resolve(cwd, path))
          .pipe(Effect.orDie)
      }),
      rg: Effect.fn("AgentTools.rg")(function* (options) {
        yield* Effect.logInfo(`Calling "rg"`).pipe(Effect.annotateLogs(options))
        const cwd = yield* CurrentDirectory
        const args = ["--max-filesize", "1M", "--line-number"]
        if (options.glob) {
          args.push("--glob", options.glob)
        }
        args.push(options.pattern)
        let stream = pipe(
          spawner.streamLines(
            ChildProcess.make(Rg.rgPath, args, {
              cwd,
              stdin: "ignore",
            }),
          ),
          Stream.map((line) => {
            if (line.length <= 500) return line
            return line.slice(0, 500) + "...[truncated]"
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
      bash: Effect.fn("AgentTools.bash")(function* (command) {
        yield* Effect.logInfo(`Calling "bash"`).pipe(
          Effect.annotateLogs({ command }),
        )
        const cwd = yield* CurrentDirectory
        const cmd = ChildProcess.make("bash", ["-c", command], {
          cwd,
          stdin: "ignore",
        })
        return yield* spawner.string(cmd).pipe(Effect.orDie)
      }),
      httpGet: Effect.fn("AgentTools.httpGet")(function* (url) {
        yield* Effect.logInfo(`Calling "httpGet"`).pipe(
          Effect.annotateLogs({ url }),
        )
        const response = yield* Effect.promise(() => fetch(url)).pipe(
          Effect.orDie,
        )
        return yield* Effect.promise(() => response.text()).pipe(Effect.orDie)
      }),
      sleep: Effect.fn("AgentTools.sleep")(function* (ms) {
        yield* Effect.logInfo(`Calling "sleep" for ${ms}ms`)
        return yield* Effect.sleep(ms)
      }),
      applyPatch: Effect.fn("AgentTools.applyPatch")(function* (options) {
        yield* Effect.logInfo(`Calling "applyPatch"`).pipe(
          Effect.annotateLogs({ path: options.path }),
        )
        const cwd = yield* CurrentDirectory
        const file = pathService.resolve(cwd, options.path)
        const input = yield* fs.readFileString(file)
        const next = patchContent(file, input, options.patchText)
        yield* fs.writeFileString(file, next)
        const path = pathService.relative(cwd, file).replaceAll("\\", "/")
        return `M ${path}`
      }, Effect.orDie),
      taskComplete: Effect.fn("AgentTools.taskComplete")(function* (message) {
        const deferred = yield* TaskCompleteDeferred
        yield* Deferred.succeed(deferred, message)
      }),
    })
  }),
).pipe(Layer.provide(NodeServices.layer))

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

export class CurrentDirectory extends ServiceMap.Service<
  CurrentDirectory,
  string
>()("clanka/AgentTools/CurrentDirectory") {}

export class TaskCompleteDeferred extends ServiceMap.Service<
  TaskCompleteDeferred,
  Deferred.Deferred<string>
>()("clanka/AgentTools/TaskCompleteDeferred") {}

export const AgentTools = Toolkit.make(
  Tool.make("readFile", {
    description: "Read a file and optionally filter the lines to return.",
    parameters: Schema.Struct({
      path: Schema.String,
      startLine: Schema.optional(Schema.Number),
      endLine: Schema.optional(Schema.Number),
    }),
    success: Schema.String,
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
    success: Schema.String,
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
  Tool.make("taskComplete", {
    description:
      "Call this when you have fully completed the user's task, completely ending the session",
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
          fs.stream(pathService.join(cwd, options.path)),
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
          Effect.orDie,
        )
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
        return yield* Effect.promise(() => Glob.glob(pattern, { cwd })).pipe(
          Effect.map(Array.join("\n")),
        )
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
      taskComplete: Effect.fn("AgentTools.taskComplete")(function* (message) {
        const deferred = yield* TaskCompleteDeferred
        yield* Deferred.succeed(deferred, message)
      }),
    })
  }),
).pipe(Layer.provide(NodeServices.layer))

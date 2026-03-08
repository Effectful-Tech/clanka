import {
  Array,
  Data,
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
import { parsePatch, patchChunks } from "./ApplyPatch.ts"

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
      "Apply a patch across one or more files. Use this to add, delete or update files.",
    parameters: Schema.String.annotate({
      identifier: "patchText",
      documentation: "Wrapped patch with Add/Delete/Update sections.",
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
  Tool.make("ls", {
    description: "List the contents of a directory",
    parameters: Schema.String.annotate({
      identifier: "directory",
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
      ls: Effect.fn("AgentTools.ls")(function* (path) {
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
      bash: Effect.fn("AgentTools.bash")(
        function* (command) {
          yield* Effect.logInfo(`Calling "bash"`).pipe(
            Effect.annotateLogs({ command }),
          )
          const cwd = yield* CurrentDirectory
          const cmd = ChildProcess.make("bash", ["-c", command], {
            cwd,
            stdin: "ignore",
          })
          const handle = yield* spawner.spawn(cmd)
          return yield* handle.all.pipe(
            Stream.decodeText,
            Stream.mkString,
            Effect.flatMap(
              Effect.fnUntraced(function* (output) {
                const exitCode = yield* handle.exitCode
                if (exitCode === 0) return output
                // @effect-diagnostics-next-line globalErrorInEffectFailure:off
                return yield* Effect.fail(
                  new Error(
                    `Command failed with exit code ${exitCode}: ${output}`,
                  ),
                )
              }),
            ),
          )
        },
        Effect.scoped,
        Effect.orDie,
      ),
      sleep: Effect.fn("AgentTools.sleep")(function* (ms) {
        yield* Effect.logInfo(`Calling "sleep" for ${ms}ms`)
        return yield* Effect.sleep(ms)
      }),
      applyPatch: Effect.fn("AgentTools.applyPatch")(function* (patchText) {
        yield* Effect.logInfo(`Calling "applyPatch"`)
        const cwd = yield* CurrentDirectory
        // const err = (cause: unknown) =>
        //   cause instanceof Error ? cause : new Error(String(cause))
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
        const out = [] as string[]
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

        return `Success. Updated the following files:\n${out.join("\n")}`
      }, Effect.orDie),
      taskComplete: Effect.fn("AgentTools.taskComplete")(function* (message) {
        const deferred = yield* TaskCompleteDeferred
        yield* Deferred.succeed(deferred, message)
      }),
    })
  }),
).pipe(Layer.provide(NodeServices.layer))

export class ApplyPatchError extends Data.TaggedClass("ApplyPatchError")<{
  readonly message: string
}> {}

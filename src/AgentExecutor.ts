/**
 * @since 1.0.0
 */
import {
  Cause,
  Console,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  pipe,
  Queue,
  Scope,
  ServiceMap,
  Stream,
} from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import * as NodeConsole from "node:console"
import * as NodeVm from "node:vm"
import { Writable } from "node:stream"
import {
  AgentToolHandlers,
  AgentTools,
  CurrentDirectory,
  SubagentExecutor,
  TaskCompleter,
} from "./AgentTools.ts"
import { ToolkitRenderer } from "./ToolkitRenderer.ts"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { HttpClient } from "effect/unstable/http/HttpClient"

/**
 * @since 1.0.0
 * @category Services
 */
export class AgentExecutor extends ServiceMap.Service<
  AgentExecutor,
  {
    readonly toolsDts: Effect.Effect<string>
    readonly agentsMd: Effect.Effect<Option.Option<string>>
    execute(options: {
      readonly script: string
      readonly onTaskComplete: (summary: string) => Effect.Effect<void>
      readonly onSubagent: (message: string) => Effect.Effect<string>
    }): Stream.Stream<string>
  }
>()("clanka/AgentExecutor") {}

/**
 * @since 1.0.0
 * @category Constructors
 */
export const makeLocal = Effect.fnUntraced(function* <
  Toolkit extends Toolkit.Any = never,
>(options: {
  readonly directory: string
  readonly tools?: Toolkit | undefined
}): Effect.fn.Return<
  AgentExecutor["Service"],
  never,
  | ToolkitRenderer
  | FileSystem.FileSystem
  | Path.Path
  | Tool.HandlersFor<typeof AgentTools.tools>
  | Exclude<
      Toolkit extends Toolkit.Toolkit<infer T>
        ? Tool.HandlersFor<T> | Tool.HandlerServices<T[keyof T]>
        : never,
      CurrentDirectory | SubagentExecutor | TaskCompleter
    >
> {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const renderer = yield* ToolkitRenderer
  const AllTools = Toolkit.merge(
    AgentTools,
    (options.tools as unknown as Toolkit.Toolkit<{}>) ?? Toolkit.empty,
  )
  const tools = yield* AllTools
  const toolsDts = Effect.succeed(renderer.render(AllTools))

  const services = yield* Effect.services()

  const toolEntries = Object.entries(tools.tools).map(([name, tool]) => {
    const handler = services.mapUnsafe.get(tool.id) as Tool.Handler<string>
    return {
      name,
      services: ServiceMap.merge(services, handler.services),
      handler: handler.handler,
    }
  })

  const execute = Effect.fnUntraced(function* (opts: {
    readonly script: string
    readonly onTaskComplete: (summary: string) => Effect.Effect<void>
    readonly onSubagent: (message: string) => Effect.Effect<string>
  }) {
    const output = yield* Queue.unbounded<string, Cause.Done>()
    const console = yield* makeConsole(output)
    const handlerScope = Scope.makeUnsafe("parallel")
    const trackFiber = Fiber.runIn(handlerScope)

    const taskServices = ServiceMap.make(
      TaskCompleter,
      opts.onTaskComplete,
    ).pipe(
      ServiceMap.add(CurrentDirectory, options.directory),
      ServiceMap.add(SubagentExecutor, opts.onSubagent),
      ServiceMap.add(Console.Console, console),
    )

    yield* Effect.gen(function* () {
      const console = yield* Console.Console
      let running = 0

      const vmScript = new NodeVm.Script(`async function main() {
${opts.script}
}`)
      const sandbox: ScriptSandbox = {
        main: defaultMain,
        console,
        fetch,
        process: undefined,
      }

      for (let i = 0; i < toolEntries.length; i++) {
        const { name, handler, services } = toolEntries[i]!
        const runFork = Effect.runForkWith(
          ServiceMap.merge(services, taskServices),
        )

        // oxlint-disable-next-line typescript/no-explicit-any
        sandbox[name] = function (params: any) {
          running++
          const fiber = trackFiber(runFork(handler(params, {})))
          return new Promise((resolve, reject) => {
            fiber.addObserver((exit) => {
              running--
              if (exit._tag === "Success") {
                return resolve(exit.value)
              }
              if (Cause.hasInterruptsOnly(exit.cause)) return
              reject(Cause.squash(exit.cause))
            })
          })
        }
      }

      vmScript.runInNewContext(sandbox, {
        timeout: 1000,
      })
      yield* Effect.promise(sandbox.main)
      while (true) {
        yield* Effect.yieldNow
        if (running === 0) break
      }
    }).pipe(
      Effect.ensuring(Scope.close(handlerScope, Exit.void)),
      Effect.catchCause(Effect.logFatal),
      Effect.provideService(Console.Console, console),
      Effect.ensuring(Queue.end(output)),
      Effect.forkScoped,
    )

    return Stream.fromQueue(output)
  }, Stream.unwrap)

  return AgentExecutor.of({
    toolsDts,
    agentsMd: pipe(
      fs.readFileString(pathService.join(options.directory, "AGENTS.md")),
      Effect.option,
    ),
    execute,
  })
})

/**
 * @since 1.0.0
 * @category Layers
 */
export const layerLocal = <Toolkit extends Toolkit.Any = never>(options: {
  readonly directory: string
  readonly tools?: Toolkit | undefined
}): Layer.Layer<
  AgentExecutor,
  never,
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner
  | HttpClient
  | Exclude<
      Toolkit extends Toolkit.Toolkit<infer T>
        ? Tool.HandlersFor<T> | Tool.HandlerServices<T[keyof T]>
        : never,
      CurrentDirectory | SubagentExecutor | TaskCompleter
    >
> =>
  Layer.effect(AgentExecutor, makeLocal(options)).pipe(
    Layer.provide([AgentToolHandlers, ToolkitRenderer.layer]),
  )

// ------------------------------------------
// Internal
// -------------------------------------------

interface ScriptSandbox {
  main: () => Promise<void>
  console: Console.Console
  [toolName: string]: unknown
}

const defaultMain = () => Promise.resolve()

const makeConsole = Effect.fn(function* (
  queue: Queue.Queue<string, Cause.Done>,
) {
  const writable = new QueueWriteStream(queue)
  const newConsole = new NodeConsole.Console(writable)
  yield* Effect.addFinalizer(() => {
    writable.end()
    return Effect.void
  })
  return newConsole
})

class QueueWriteStream extends Writable {
  readonly queue: Queue.Enqueue<string, Cause.Done>
  constructor(queue: Queue.Enqueue<string, Cause.Done>) {
    super()
    this.queue = queue
  }
  _write(
    // oxlint-disable-next-line typescript/no-explicit-any
    chunk: any,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    Queue.offerUnsafe(this.queue, chunk.toString())
    callback()
  }
}

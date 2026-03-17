/**
 * @since 1.0.0
 */
import * as NodeConsole from "node:console"
import * as NodeVm from "node:vm"
import { Writable } from "node:stream"
import {
  AgentToolHandlers,
  AgentTools,
  AgentToolsWithSearch,
  CurrentDirectory,
  SubagentExecutor,
  TaskCompleter,
} from "./AgentTools.ts"
import { ToolkitRenderer } from "./ToolkitRenderer.ts"
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import * as ServiceMap from "effect/ServiceMap"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as FileSystem from "effect/FileSystem"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import * as Path from "effect/Path"
import type * as Tool from "effect/unstable/ai/Tool"
import * as Queue from "effect/Queue"
import * as Cause from "effect/Cause"
import * as Scope from "effect/Scope"
import * as Fiber from "effect/Fiber"
import * as Console from "effect/Console"
import * as Exit from "effect/Exit"
import { pipe, flow, identity } from "effect/Function"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as Layer from "effect/Layer"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import * as Schema from "effect/Schema"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as Result from "effect/Result"
import { SemanticSearch } from "./SemanticSearch.ts"

/**
 * @since 1.0.0
 * @category Services
 */
export class AgentExecutor extends ServiceMap.Service<
  AgentExecutor,
  {
    readonly capabilities: Effect.Effect<Capabilities>
    execute(options: {
      readonly script: string
      readonly onTaskComplete: (summary: string) => Effect.Effect<void>
      readonly onSubagent: (message: string) => Effect.Effect<string>
    }): Stream.Stream<string>
  }
>()("clanka/AgentExecutor") {}

/**
 * @since 1.0.0
 * @category Models
 */
export class Capabilities extends Schema.Class<Capabilities>("Capabilities")({
  toolsDts: Schema.String,
  agentsMd: Schema.Option(Schema.String),
  supportsSearch: Schema.Boolean,
}) {}

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
  | Tool.HandlersFor<typeof AgentToolsWithSearch.tools>
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
  const search = yield* Effect.serviceOption(SemanticSearch)
  const hasSearch = Option.isSome(search)
  const AllTools = Toolkit.merge(
    hasSearch ? AgentToolsWithSearch : AgentTools,
    (options.tools as unknown as Toolkit.Toolkit<{}>) ?? Toolkit.empty,
  )
  const tools = yield* AllTools
  const toolsDts = renderer.render(AllTools)

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

    const taskServices = ServiceMap.mutate(
      ServiceMap.empty(),
      flow(
        ServiceMap.add(TaskCompleter, opts.onTaskComplete),
        ServiceMap.add(CurrentDirectory, options.directory),
        ServiceMap.add(SubagentExecutor, opts.onSubagent),
        ServiceMap.add(Console.Console, console),
        Option.isSome(search)
          ? ServiceMap.add(SemanticSearch, search.value)
          : identity,
      ),
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
    capabilities: Effect.gen(function* () {
      const agentsMd = yield* Effect.option(
        fs.readFileString(pathService.join(options.directory, "AGENTS.md")),
      )
      return new Capabilities({
        toolsDts,
        agentsMd,
        supportsSearch: hasSearch,
      })
    }),
    execute,
  })
})

/**
 * @since 1.0.0
 * @category Constructors
 */
export const makeRpc = Effect.gen(function* () {
  const client = yield* RpcClient.make(Rpcs, {
    spanPrefix: "AgentExecutorClient",
  })

  return AgentExecutor.of({
    capabilities: Effect.orDie(client.capabilities()),
    execute: (opts) =>
      Scope.Scope.useSync((scope) =>
        client.execute({ script: opts.script }).pipe(
          Stream.tap((part) => {
            switch (part._tag) {
              case "Text": {
                return Effect.void
              }
              case "TaskComplete": {
                return opts.onTaskComplete(part.summary)
              }
              case "Subagent": {
                const id = part.id
                return pipe(
                  opts.onSubagent(part.prompt),
                  Effect.flatMap((output) =>
                    client.subagentOutput({ id, output }),
                  ),
                  Effect.forkIn(scope),
                )
              }
            }
          }),
          Stream.orDie,
          Stream.filterMap((part) =>
            part._tag === "Text" ? Result.succeed(part.text) : Result.failVoid,
          ),
        ),
      ).pipe(Stream.unwrap),
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
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
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

/**
 * Create an AgentExecutor that communicates with a remote RpcServer serving the
 * AgentExecutor protocol.
 *
 * @since 1.0.0
 * @category Layers
 */
export const layerRpc: Layer.Layer<AgentExecutor, never, RpcClient.Protocol> =
  Layer.effect(AgentExecutor, makeRpc)

/**
 * Create a RpcServer that serves the AgentExecutor rpc protocol.
 *
 * This can be used to run the AgentExecutor in a remote location.
 *
 * @since 1.0.0
 * @category Layers
 */
export const layerRpcServer = <Toolkit extends Toolkit.Any = never>(options: {
  readonly directory: string
  readonly tools?: Toolkit | undefined
}): Layer.Layer<
  never,
  never,
  | RpcServer.Protocol
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Exclude<
      Toolkit extends Toolkit.Toolkit<infer T>
        ? Tool.HandlersFor<T> | Tool.HandlerServices<T[keyof T]>
        : never,
      CurrentDirectory | SubagentExecutor | TaskCompleter
    >
> =>
  RpcServer.layer(Rpcs, {
    spanPrefix: "AgentExecutorServer",
    disableFatalDefects: true,
  }).pipe(
    Layer.provide(
      Rpcs.toLayer(
        Effect.gen(function* () {
          const local = yield* makeLocal(options)
          const subagentResumes = new Map<
            number,
            (effect: Effect.Effect<string>) => void
          >()

          return Rpcs.of({
            capabilities: () => local.capabilities,
            subagentOutput: ({ id, output }) => {
              const resume = subagentResumes.get(id)
              if (resume) {
                resume(Effect.succeed(output))
                subagentResumes.delete(id)
              }
              return Effect.void
            },
            execute: Effect.fnUntraced(function* ({ script }) {
              const queue = yield* Queue.unbounded<
                typeof ExecuteOutput.Type,
                Cause.Done
              >()
              let subagentId = 0

              yield* pipe(
                local.execute({
                  script,
                  onTaskComplete(summary) {
                    return Queue.offer(queue, {
                      _tag: "TaskComplete",
                      summary,
                    })
                  },
                  onSubagent(prompt) {
                    const id = subagentId++
                    return Effect.callback((resume) => {
                      subagentResumes.set(id, resume)
                      Queue.offerUnsafe(queue, {
                        _tag: "Subagent",
                        id,
                        prompt,
                      })
                      return Effect.sync(() => {
                        subagentResumes.delete(id)
                      })
                    })
                  },
                }),
                Stream.runForEachArray((parts) => {
                  for (const part of parts) {
                    Queue.offerUnsafe(queue, {
                      _tag: "Text",
                      text: part,
                    })
                  }
                  return Effect.void
                }),
                Effect.forkScoped,
              )

              return queue
            }),
          })
        }),
      ),
    ),
    Layer.provide([AgentToolHandlers, ToolkitRenderer.layer]),
  )

/**
 * @since 1.0.0
 * @category Rpcs
 */
export const ExecuteOutput = Schema.TaggedUnion({
  Text: { text: Schema.String },
  TaskComplete: { summary: Schema.String },
  Subagent: { id: Schema.Finite, prompt: Schema.String },
})

/**
 * @since 1.0.0
 * @category Rpcs
 */
export class Rpcs extends RpcGroup.make(
  Rpc.make("capabilities", {
    success: Capabilities,
  }),
  Rpc.make("subagentOutput", {
    payload: {
      id: Schema.Finite,
      output: Schema.String,
    },
  }),
  Rpc.make("execute", {
    payload: Schema.Struct({
      script: Schema.String,
    }),
    success: ExecuteOutput,
    stream: true,
  }),
) {}

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

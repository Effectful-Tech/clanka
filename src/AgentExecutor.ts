/**
 * @since 1.0.0
 */
import * as NodeConsole from "node:console"
import * as NodeOs from "node:os"
import * as NodeVm from "node:vm"
import { Writable } from "node:stream"
import {
  AgentToolHandlers,
  type DelegateResult,
  type SubagentInfo,
  type SubagentResult,
  AgentTools,
  AgentToolsWithSearch,
  CurrentDirectory,
  DirectoryChanger,
  ImageAttacher,
  type ImageAttachment,
  SubagentExecutor,
  type Subagents,
  subagentsUnavailable,
  TaskCompleter,
} from "./AgentTools.ts"
import * as Image from "./Image.ts"
import { ToolkitRenderer } from "./ToolkitRenderer.ts"
import * as AgentSkills from "./AgentSkills.ts"
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import type * as HttpClient from "effect/http/HttpClient"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as FileSystem from "effect/FileSystem"
import * as Toolkit from "effect/ai/Toolkit"
import * as Path from "effect/Path"
import type * as Tool from "effect/ai/Tool"
import * as Queue from "effect/Queue"
import * as Cause from "effect/Cause"
import * as Scope from "effect/Scope"
import * as Fiber from "effect/Fiber"
import * as Console from "effect/Console"
import * as Exit from "effect/Exit"
import { pipe, identity } from "effect/Function"
import * as RpcClient from "effect/rpc/RpcClient"
import * as Layer from "effect/Layer"
import * as RpcServer from "effect/rpc/RpcServer"
import * as Schema from "effect/Schema"
import * as RpcGroup from "effect/rpc/RpcGroup"
import * as Rpc from "effect/rpc/Rpc"
import * as Result from "effect/Result"
import { SemanticSearch } from "./SemanticSearch/Service.ts"
import { preprocessScript } from "./ScriptPreprocessing.ts"
import * as References from "effect/References"

/**
 * @since 1.0.0
 * @category Services
 */
export class AgentExecutor extends Context.Service<
  AgentExecutor,
  {
    readonly capabilities: Effect.Effect<Capabilities>
    execute(options: ExecuteOptions): Stream.Stream<string>
    executeUnsafe<Tool extends keyof typeof AgentTools.tools>(options: {
      readonly tool: Tool
      readonly params: (typeof AgentTools.tools)[Tool]["parametersSchema"]["Encoded"]
    }): Effect.Effect<Schema.Json>
  }
>()("clanka/AgentExecutor") {}

/**
 * @since 1.0.0
 * @category Models
 */
export interface ExecuteOptions {
  readonly script: string
  /**
   * Fails with a message for the script when the task cannot be completed
   * yet, for example while sub-agents are still running.
   */
  readonly onTaskComplete: (summary: string) => Effect.Effect<void, string>
  /**
   * The sub-agents of the agent running the script.
   */
  readonly subagents: Subagents
  /**
   * Receives every image `readFile` attached while the script ran.
   */
  readonly onImage: (image: ImageAttachment) => Effect.Effect<void>
}

/**
 * @since 1.0.0
 * @category Models
 */
export class Capabilities extends Schema.Class<Capabilities>("Capabilities")({
  toolsDts: Schema.String,
  agentsMd: Schema.Option(Schema.String),
  supportsSearch: Schema.Boolean,
  /**
   * Skills available on the executor filesystem.
   */
  skills: Schema.Array(AgentSkills.Skill).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
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
      | CurrentDirectory
      | DirectoryChanger
      | SubagentExecutor
      | TaskCompleter
      | ImageAttacher
    >
> {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const renderer = yield* ToolkitRenderer
  let currentDirectory = pathService.resolve(options.directory)
  const changeDirectory = Effect.fnUntraced(function* (directory: string) {
    const target = pathService.resolve(currentDirectory, directory)
    const info = yield* fs.stat(target)
    if (info.type !== "Directory") {
      return yield* Effect.die(new Error(`Not a directory: ${target}`))
    }
    currentDirectory = target
    return target
  }, Effect.orDie)
  const search = yield* Effect.serviceOption(SemanticSearch)
  const hasSearch = Option.isSome(search)
  const AllTools = Toolkit.merge(
    hasSearch ? AgentToolsWithSearch : AgentTools,
    (options.tools as unknown as Toolkit.Toolkit<{}>) ?? Toolkit.empty,
  )
  const tools = yield* AllTools
  const toolsDts = renderer.render(AllTools)

  const services = yield* Effect.context()

  const toolEntries = Object.entries(tools.tools).map(([name, tool]) => {
    const handler = services.mapUnsafe.get(tool.id) as Tool.Handler<string>
    return {
      name,
      services: Context.merge(services, handler.context),
      handler: handler.handler,
    }
  })

  if (typeof process !== "undefined") {
    process.on("uncaughtException", () => {})
  }

  const execute = Effect.fnUntraced(function* (opts: ExecuteOptions) {
    const output = yield* Queue.unbounded<string, Cause.Done>()
    const console = yield* makeConsole(output)
    const handlerScope = Scope.makeUnsafe("parallel")
    const trackFiber = Fiber.runIn(handlerScope)

    const taskServices = Context.empty().pipe(
      Context.add(TaskCompleter, opts.onTaskComplete),
      Context.add(DirectoryChanger, changeDirectory),
      Context.add(SubagentExecutor, opts.subagents),
      Context.add(ImageAttacher, opts.onImage),
      Context.add(Console.Console, console),
      Context.add(References.CurrentLogAnnotations, {}),
      Option.isSome(search)
        ? Context.add(SemanticSearch, search.value)
        : identity,
    )

    yield* Effect.gen(function* () {
      const console = yield* Console.Console
      let running = 0

      const vmScript = compileScript(opts.script)
      const sandbox: ScriptSandbox = {
        main: defaultMain,
        console,
        fetch,
        process: undefined,
      }

      for (let i = 0; i < toolEntries.length; i++) {
        const { name, handler, services } = toolEntries[i]!
        const toolServices = Context.merge(services, taskServices)

        // oxlint-disable-next-line typescript/no-explicit-any
        sandbox[name] = function (params: any) {
          const runFork = Effect.runForkWith(
            Context.add(toolServices, CurrentDirectory, currentDirectory),
          )
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
      const skills = yield* AgentSkills.discover({
        directory: options.directory,
        homeDirectory: homeDirectory(),
        hermesHome: Option.fromNullishOr(process.env.HERMES_HOME),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      )
      return new Capabilities({
        toolsDts,
        agentsMd,
        supportsSearch: hasSearch,
        skills,
      })
    }),
    execute,
    executeUnsafe: (opts) =>
      Effect.suspend(() => {
        const tool = tools.tools[opts.tool as keyof typeof tools.tools]
        if (!tool) {
          return Effect.die(new Error(`Unknown tool: ${opts.tool}`))
        }
        const handler = services.mapUnsafe.get(tool.id) as Tool.Handler<string>
        if (!handler) {
          return Effect.die(new Error(`Unknown tool: ${opts.tool}`))
        }

        const taskServices = handler.context.pipe(
          Context.add(TaskCompleter, () => Effect.void),
          Context.add(CurrentDirectory, currentDirectory),
          Context.add(DirectoryChanger, changeDirectory),
          Context.add(SubagentExecutor, subagentsUnavailable),
          // Direct tool calls have no model turn to attach images to.
          Context.add(ImageAttacher, () => Effect.void),
          Context.add(References.CurrentLogAnnotations, {}),
          Option.isSome(search)
            ? Context.add(SemanticSearch, search.value)
            : identity,
        )

        const encodeSuccess = Schema.encodeUnknownEffect(
          Schema.toCodecJson(tool.successSchema as Schema.Top),
        )
        return pipe(
          handler.handler(opts.params, {}),
          Effect.flatMap(encodeSuccess),
          Effect.provideContext(taskServices),
          Effect.orDie,
        ) as Effect.Effect<Schema.Json>
      }),
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
              case "Request": {
                const id = part.id
                return pipe(
                  handleRequest(opts, part.request),
                  Effect.exit,
                  Effect.flatMap((exit) =>
                    client.respond({ id, response: exitToResponse(exit) }),
                  ),
                  Effect.forkIn(scope),
                )
              }
              case "Image": {
                return opts.onImage({
                  fileName: part.fileName,
                  mediaType: part.mediaType,
                  data: part.data,
                })
              }
            }
          }),
          Stream.orDie,
          Stream.filterMap((part) =>
            part._tag === "Text" ? Result.succeed(part.text) : Result.failVoid,
          ),
        ),
      ).pipe(Stream.unwrap),
    executeUnsafe(options) {
      return client.executeUnsafe(options).pipe(Effect.orDie)
    },
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
      | CurrentDirectory
      | DirectoryChanger
      | SubagentExecutor
      | TaskCompleter
      | ImageAttacher
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
      | CurrentDirectory
      | DirectoryChanger
      | SubagentExecutor
      | TaskCompleter
      | ImageAttacher
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
          const requestResumes = new Map<
            number,
            (effect: Effect.Effect<Schema.Json, string>) => void
          >()
          let requestId = 0

          return Rpcs.of({
            capabilities: () => local.capabilities,
            respond: ({ id, response }) => {
              const resume = requestResumes.get(id)
              if (resume) {
                requestResumes.delete(id)
                resume(
                  response._tag === "Success"
                    ? Effect.succeed(response.value)
                    : Effect.fail(response.message),
                )
              }
              return Effect.void
            },
            execute: Effect.fnUntraced(function* ({ script }) {
              const queue = yield* Queue.unbounded<
                typeof ExecuteOutput.Type,
                Cause.Done
              >()
              // Sends a request to the client and waits for its response.
              // IDs come from a server-wide counter, so concurrent and nested
              // execute streams never collide.
              const request = (request: typeof AgentRequest.Type) =>
                Effect.callback<Schema.Json, string>((resume) => {
                  const id = requestId++
                  requestResumes.set(id, resume)
                  Queue.offerUnsafe(queue, { _tag: "Request", id, request })
                  return Effect.sync(() => {
                    requestResumes.delete(id)
                  })
                })
              yield* pipe(
                local.execute({
                  script,
                  onTaskComplete: (summary) =>
                    Effect.asVoid(request({ _tag: "TaskComplete", summary })),
                  subagents: {
                    delegate: ({ prompt, background }) =>
                      request({ _tag: "Delegate", prompt, background }).pipe(
                        Effect.orDie,
                        Effect.map((value) => value as DelegateResult),
                      ),
                    waitAgents: (ids) =>
                      request({ _tag: "WaitAgents", ids }).pipe(
                        Effect.map(
                          (value) => value as ReadonlyArray<SubagentResult>,
                        ),
                      ),
                    messageAgent: ({ id, message }) =>
                      request({ _tag: "MessageAgent", id, message }).pipe(
                        Effect.map((value) => value as SubagentResult),
                      ),
                    stopAgent: (id) =>
                      request({ _tag: "StopAgent", id }).pipe(
                        Effect.map((value) => value as SubagentResult),
                      ),
                    listAgents: request({ _tag: "ListAgents" }).pipe(
                      Effect.orDie,
                      Effect.map(
                        (value) => value as ReadonlyArray<SubagentInfo>,
                      ),
                    ),
                  },
                  onImage(image) {
                    return Queue.offer(queue, {
                      _tag: "Image",
                      fileName: image.fileName,
                      mediaType: image.mediaType,
                      data: image.data,
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
                Effect.onExit((exit) =>
                  Exit.isSuccess(exit)
                    ? Queue.end(queue)
                    : Queue.failCause(queue, exit.cause),
                ),
                Effect.forkScoped,
              )

              return queue
            }),
            executeUnsafe(opts) {
              return local.executeUnsafe(opts as any)
            },
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
export const AgentRequest = Schema.TaggedUnion({
  TaskComplete: { summary: Schema.String },
  Delegate: { prompt: Schema.String, background: Schema.Boolean },
  WaitAgents: { ids: Schema.UndefinedOr(Schema.Array(Schema.String)) },
  MessageAgent: { id: Schema.String, message: Schema.String },
  StopAgent: { id: Schema.String },
  ListAgents: {},
})

/**
 * The client's answer to a `Request`. `Failure` carries a message for the
 * script; a failed foreground `delegate` is raised there as a defect.
 *
 * @since 1.0.0
 * @category Rpcs
 */
export const AgentResponse = Schema.TaggedUnion({
  Success: { value: Schema.Json },
  Failure: { message: Schema.String },
})

/**
 * @since 1.0.0
 * @category Rpcs
 */
export const ExecuteOutput = Schema.TaggedUnion({
  Text: { text: Schema.String },
  Request: { id: Schema.Finite, request: AgentRequest },
  Image: {
    fileName: Schema.String,
    mediaType: Image.ImageMediaType,
    data: Schema.Uint8Array,
  },
})

/**
 * @since 1.0.0
 * @category Rpcs
 */
export class Rpcs extends RpcGroup.make(
  Rpc.make("capabilities", {
    success: Capabilities,
  }),
  Rpc.make("respond", {
    payload: {
      id: Schema.Finite,
      response: AgentResponse,
    },
  }),
  Rpc.make("execute", {
    payload: Schema.Struct({
      script: Schema.String,
    }),
    success: ExecuteOutput,
    stream: true,
  }),
  Rpc.make("executeUnsafe", {
    payload: Schema.Struct({
      tool: Schema.String,
      params: Schema.Json,
    }),
    success: Schema.Json,
  }),
) {}

// ------------------------------------------
// Internal
// -------------------------------------------

const handleRequest = (
  opts: ExecuteOptions,
  request: typeof AgentRequest.Type,
): Effect.Effect<unknown, string> => {
  switch (request._tag) {
    case "TaskComplete":
      return opts.onTaskComplete(request.summary)
    case "Delegate":
      return opts.subagents.delegate({
        prompt: request.prompt,
        background: request.background,
      })
    case "WaitAgents":
      return opts.subagents.waitAgents(request.ids)
    case "MessageAgent":
      return opts.subagents.messageAgent({
        id: request.id,
        message: request.message,
      })
    case "StopAgent":
      return opts.subagents.stopAgent(request.id)
    case "ListAgents":
      return opts.subagents.listAgents
  }
}

const exitToResponse = (
  exit: Exit.Exit<unknown, string>,
): typeof AgentResponse.Type => {
  if (Exit.isSuccess(exit)) {
    return { _tag: "Success", value: (exit.value ?? null) as Schema.Json }
  }
  const error = Cause.squash(exit.cause)
  return {
    _tag: "Failure",
    message:
      typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : String(error),
  }
}

interface ScriptSandbox {
  main: () => Promise<void>
  console: Console.Console
  [toolName: string]: unknown
}

const wrapScript = (script: string): string => `async function main() {
${script}
}`

const compileScript = (script: string): NodeVm.Script => {
  try {
    return new NodeVm.Script(wrapScript(script))
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error
    }

    const preprocessed = preprocessScript(script)
    if (preprocessed === script) {
      throw error
    }

    try {
      return new NodeVm.Script(wrapScript(preprocessed))
    } catch {
      throw error
    }
  }
}

const defaultMain = () => Promise.resolve()

const homeDirectory = (): Option.Option<string> => {
  const fromEnv = process.env.HOME
  if (fromEnv) return Option.some(fromEnv)
  try {
    return Option.some(NodeOs.homedir())
  } catch {
    return Option.none()
  }
}

const makeConsole = Effect.fn(function* (
  queue: Queue.Queue<string, Cause.Done>,
) {
  const writable = new QueueWriteStream(queue)
  const newConsole = new NodeConsole.Console({
    stdout: writable,
    colorMode: false,
  })
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

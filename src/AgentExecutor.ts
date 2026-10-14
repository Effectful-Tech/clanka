/**
 * @since 1.0.0
 */
import * as NodeConsole from "node:console"
import * as NodeOs from "node:os"
import * as NodeVm from "node:vm"
import { Writable } from "node:stream"
import { Worker } from "node:worker_threads"
import type * as NodeWorkerThreads from "node:worker_threads"
import {
  AgentToolHandlers,
  type DelegateResult,
  type SubagentInfo,
  type SubagentResult,
  AgentTools,
  AgentToolsWithSearch,
  CommandLimits,
  CurrentDirectory,
  defaultBashTimeout,
  DirectoryChanger,
  type ExcludableTool,
  ImageAttacher,
  type ImageAttachment,
  makeBashTool,
  SubagentExecutor,
  type Subagents,
  subagentsUnavailable,
  TaskCompleter,
} from "./AgentTools.ts"
import * as Image from "./Image.ts"
import { ToolkitRenderer } from "./ToolkitRenderer.ts"
import * as AgentEnvironment from "./AgentEnvironment.ts"
import * as AgentSkills from "./AgentSkills.ts"
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import type * as HttpClient from "effect/http/HttpClient"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
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
      /**
       * The environment the tool runs in. Defaults to the startup
       * environment. Changes made by the tool are not returned.
       */
      readonly environment?: ExecutionEnvironment | undefined
    }): Effect.Effect<Schema.Json>
    /**
     * Render the AGENTS.md files and skills that apply to the environment's
     * directory and that the model has not seen yet. The agent calls it once
     * after the scripts of a model response, so one update covers all of
     * them; `execute` itself never renders one.
     *
     * With `reset`, everything sent since the system prompt is forgotten and
     * rendered again. Any operation that rewrites the history, such as
     * compaction, must do this, so the environment's record of what the
     * model has seen matches the history.
     *
     * Optional: without it the agent sends no updates.
     */
    readonly renderEnvironment?:
      | ((
          environment: ExecutionEnvironment,
          options?: { readonly reset?: boolean | undefined } | undefined,
        ) => Effect.Effect<EnvironmentUpdate>)
      | undefined
  }
>()("clanka/AgentExecutor") {}

/**
 * @since 1.0.0
 * @category Models
 */
export interface ExecuteOptions {
  readonly script: string
  /**
   * The environment the script starts in: the `environment` of the last
   * `onEnvironment` call for this agent, or `Capabilities.environment` for
   * its first script.
   */
  readonly environment: ExecutionEnvironment
  /**
   * Receives the environment the script left behind, once, when the script
   * ends. It is also called when the script fails, times out or is
   * interrupted. Pass it to the next `execute` of the same agent.
   */
  readonly onEnvironment: (
    environment: ExecutionEnvironment,
  ) => Effect.Effect<void>
  /**
   * Fails with a message for the script when the task cannot be completed
   * yet, for example while sub-agents are still running.
   */
  readonly onTaskComplete: (summary: string) => Effect.Effect<void, string>
  /**
   * The sub-agents of the agent running the script.
   */
  readonly subagents: ExecuteSubagents
  /**
   * Receives every image `readFile` attached while the script ran.
   */
  readonly onImage: (image: ImageAttachment) => Effect.Effect<void>
  /**
   * Functions added to the script sandbox whose handlers run on the loop
   * side, next to the Agent.
   */
  readonly loopTools?: LoopToolHandlers | undefined
}

/**
 * The sub-agents of the agent running a script. `delegate` also receives the
 * environment the new agent starts in: the script's directory at the moment
 * `delegate` was called, with an update holding everything that applies to
 * it beyond the system prompt.
 *
 * @since 1.0.0
 * @category Models
 */
export interface ExecuteSubagents extends Omit<Subagents, "delegate"> {
  readonly delegate: (options: {
    readonly prompt: string
    readonly background: boolean
    readonly environment: EnvironmentUpdate
  }) => Effect.Effect<DelegateResult>
}

/**
 * The state the executor keeps for one agent, such as its working directory.
 * Only the executor reads its fields. The agent stores the value it last
 * received from `onEnvironment` and passes it to its next `execute`, so every
 * agent has its own working directory.
 *
 * @since 1.0.0
 * @category Models
 */
export class ExecutionEnvironment extends Schema.Class<ExecutionEnvironment>(
  "clanka/AgentExecutor/ExecutionEnvironment",
)({
  cwd: Schema.String,
  /**
   * Ids of the context items already in the system prompt.
   */
  baseline: Schema.Array(Schema.String),
  /**
   * Ids of the context items sent to the model in the history since.
   */
  seen: Schema.Array(Schema.String),
}) {}

/**
 * @since 1.0.0
 * @category Models
 */
export class EnvironmentUpdate extends Schema.Class<EnvironmentUpdate>(
  "clanka/AgentExecutor/EnvironmentUpdate",
)({
  /**
   * The environment once `update` is in the history: what it describes
   * counts as seen. Store it only together with the update.
   */
  environment: ExecutionEnvironment,
  /**
   * AGENTS.md files and skills the model has not seen yet, or `None` when
   * nothing is new. The agent wraps it in an `<environment-update>` message.
   */
  update: Schema.Option(Schema.String),
}) {}

/**
 * Loop-side tool handlers by function name. A handler receives the script's
 * argument undecoded; a failure rejects the script's call with the string as
 * the error message.
 *
 * @since 1.0.0
 * @category Models
 */
export type LoopToolHandlers = Readonly<
  Record<string, (params: unknown) => Effect.Effect<unknown, string>>
>

/**
 * @since 1.0.0
 * @category Models
 */
export class Capabilities extends Schema.Class<Capabilities>("Capabilities")({
  toolsDts: Schema.String,
  /**
   * The startup AGENTS.md as rendered for the system prompt, with its path.
   */
  instructions: Schema.Option(Schema.String),
  supportsSearch: Schema.Boolean,
  /**
   * The environment of an agent's first script.
   */
  environment: ExecutionEnvironment,
  /**
   * The names of the script functions the executor offers.
   */
  tools: Schema.Array(Schema.String),
  /**
   * Skills available on the executor filesystem.
   */
  skills: Schema.Array(AgentSkills.Skill).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
}) {}

/**
 * Limits applied by the executor that runs the tools. With `layerRpcServer`
 * they are set on the server, next to the commands they bound.
 *
 * @since 1.0.0
 * @category Models
 */
export interface Limits {
  /**
   * The longest a single `bash` or `gh` command may run. For `bash` it is
   * also the default when the model passes no `timeoutMs`, and the `bash`
   * description states it.
   *
   * Defaults to 10 minutes for `bash` and no limit for `gh`, as before.
   */
  readonly commandTimeout?: Duration.Input | undefined
  /**
   * The longest a single `execute` script may run, including the tool calls
   * it awaits. A script that runs out of time is interrupted, and its output
   * so far ends with a line saying it timed out.
   *
   * Defaults to no limit.
   */
  readonly scriptTimeout?: Duration.Input | undefined
  /**
   * The most characters of `bash` and `gh` output held in memory per command.
   * Longer output keeps its start and end, with a marker in place of the
   * middle.
   *
   * Defaults to no limit.
   */
  readonly commandOutputChars?: number | undefined
}

/**
 * Options for an executor that runs scripts in this process.
 *
 * @since 1.0.0
 * @category Models
 */
export interface LocalOptions<Toolkit extends Toolkit.Any = never> {
  readonly directory: string
  readonly tools?: Toolkit | undefined
  readonly limits?: Limits | undefined
  /**
   * Built-in tools to leave out of the sandbox and the type declarations.
   * Leaving out `delegate` also leaves out the tools that address its
   * sub-agents.
   */
  readonly excludeTools?: ReadonlyArray<ExcludableTool> | undefined
}

type LocalServices<Toolkit> =
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

/**
 * @since 1.0.0
 * @category Constructors
 */
export const makeLocal = <Toolkit extends Toolkit.Any = never>(
  options: LocalOptions<Toolkit>,
): Effect.Effect<AgentExecutor["Service"], never, LocalServices<Toolkit>> =>
  Effect.map(makeLocalWith(options), (local) => local.executor)

/**
 * A local executor, plus an `execute` that also reports every change to the
 * environment while the script runs. `layerRpcServer` sends those changes to
 * its client, so the client has the latest environment when it stops reading.
 */
const makeLocalWith = Effect.fnUntraced(function* <
  Toolkit extends Toolkit.Any = never,
>(
  options: LocalOptions<Toolkit>,
): Effect.fn.Return<
  {
    readonly executor: AgentExecutor["Service"]
    readonly execute: (
      options: ExecuteOptions,
      onChange: (environment: ExecutionEnvironment) => Effect.Effect<void>,
    ) => Stream.Stream<string>
    readonly renderEnvironment: (
      environment: ExecutionEnvironment,
      options?: { readonly reset?: boolean | undefined } | undefined,
    ) => Effect.Effect<EnvironmentUpdate>
  },
  never,
  LocalServices<Toolkit>
> {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const renderer = yield* ToolkitRenderer
  const startupDirectory = pathService.resolve(options.directory)
  const startupEnvironment = new ExecutionEnvironment({
    cwd: startupDirectory,
    baseline: [],
    seen: [],
  })
  const resolveDirectory = Effect.fnUntraced(function* (
    from: string,
    directory: string,
  ) {
    const target = pathService.resolve(from, directory)
    const info = yield* fs.stat(target)
    if (info.type !== "Directory") {
      return yield* Effect.die(new Error(`Not a directory: ${target}`))
    }
    return target
  }, Effect.orDie)
  const commandTimeout = options.limits?.commandTimeout
  const commandLimits: typeof CommandLimits.Service = {
    timeout:
      commandTimeout === undefined
        ? undefined
        : Duration.fromInputUnsafe(commandTimeout),
    outputChars: options.limits?.commandOutputChars,
  }
  const scriptTimeout = Option.map(
    Option.fromUndefinedOr(options.limits?.scriptTimeout),
    Duration.fromInputUnsafe,
  )
  const excluded = excludedToolNames(options.excludeTools)
  const search = yield* Effect.serviceOption(SemanticSearch)
  const BuiltInTools = Toolkit.make(
    ...Object.values(
      Toolkit.merge(
        Option.isSome(search) ? AgentToolsWithSearch : AgentTools,
        // Same tool id, so the handler is unchanged. Only the description,
        // which states the timeout, differs.
        Toolkit.make(makeBashTool(commandLimits.timeout ?? defaultBashTimeout)),
      ).tools as Record<string, Tool.Any>,
    ).filter((tool) => !excluded.has(tool.name)),
  ) as unknown as typeof AgentToolsWithSearch
  const hasSearch = "search" in BuiltInTools.tools
  const AllTools = Toolkit.merge(
    BuiltInTools,
    (options.tools as unknown as Toolkit.Toolkit<{}>) ?? Toolkit.empty,
  )
  const tools = yield* AllTools
  const toolsDts = renderer.render(AllTools)

  const services = yield* Effect.context()

  const toolEntries = new Map(
    Object.entries(tools.tools).map(([name, tool]) => {
      const handler = services.mapUnsafe.get(tool.id) as Tool.Handler<string>
      return [
        name,
        {
          services: Context.merge(services, handler.context),
          handler: handler.handler,
        },
      ] as const
    }),
  )
  const toolNames = Array.from(toolEntries.keys())

  // Skills are read with readFile, so there are none without it.
  const offersSkills = "readFile" in tools.tools
  const home = homeDirectory()
  const discoverAt = (cwd: string) =>
    AgentEnvironment.discover({ cwd, startup: startupDirectory, home }).pipe(
      Effect.map((discovered) =>
        offersSkills ? discovered : { ...discovered, skills: [] },
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, pathService),
    )
  // What applies to the environment's directory and is neither in the
  // system prompt nor seen yet.
  const renderEnvironment = Effect.fnUntraced(function* (
    environment: ExecutionEnvironment,
    options?: { readonly reset?: boolean | undefined } | undefined,
  ) {
    const seen = options?.reset ? [] : environment.seen
    const known = new Set([...environment.baseline, ...seen])
    const discovered = yield* discoverAt(environment.cwd)
    const instructions = discovered.instructions.filter(
      (item) => !known.has(item.id),
    )
    const skills = discovered.skills.filter(
      (skill) => !known.has(AgentEnvironment.skillId(skill)),
    )
    const nothingNew = instructions.length === 0 && skills.length === 0
    return new EnvironmentUpdate({
      environment: new ExecutionEnvironment({
        cwd: environment.cwd,
        baseline: environment.baseline,
        seen: [
          ...seen,
          ...instructions.map((item) => item.id),
          ...skills.map(AgentEnvironment.skillId),
        ],
      }),
      update: nothingNew
        ? Option.none()
        : Option.some(AgentEnvironment.renderUpdate({ instructions, skills })),
    })
  })

  if (typeof process !== "undefined") {
    process.on("uncaughtException", () => {})
  }

  const execute = Effect.fnUntraced(function* (
    opts: ExecuteOptions,
    onChange?: (environment: ExecutionEnvironment) => Effect.Effect<void>,
  ) {
    const output = yield* Queue.unbounded<string, Cause.Done>()
    const console = yield* makeConsole(output)
    const handlerScope = Scope.makeUnsafe("parallel")
    const trackFiber = Fiber.runIn(handlerScope)

    // Owned by this script, so concurrent scripts never see each other's
    // directory.
    let currentDirectory = opts.environment.cwd
    const currentEnvironment = () =>
      new ExecutionEnvironment({
        cwd: currentDirectory,
        baseline: opts.environment.baseline,
        seen: opts.environment.seen,
      })
    // The script continues only once the change has been reported.
    const changeDirectory = (directory: string) =>
      resolveDirectory(currentDirectory, directory).pipe(
        Effect.tap((target) => {
          currentDirectory = target
          return onChange ? onChange(currentEnvironment()) : Effect.void
        }),
      )

    const taskServices = Context.empty().pipe(
      Context.add(TaskCompleter, opts.onTaskComplete),
      Context.add(DirectoryChanger, changeDirectory),
      Context.add(SubagentExecutor, {
        ...opts.subagents,
        // A new agent has only the system prompt, so it gets everything that
        // applies to the directory.
        delegate: (options) =>
          renderEnvironment(currentEnvironment(), { reset: true }).pipe(
            Effect.flatMap((environment) =>
              opts.subagents.delegate({ ...options, environment }),
            ),
          ),
      }),
      Context.add(ImageAttacher, opts.onImage),
      Context.add(CommandLimits, commandLimits),
      Context.add(Console.Console, console),
      Context.add(References.CurrentLogAnnotations, {}),
      Option.isSome(search)
        ? Context.add(SemanticSearch, search.value)
        : identity,
    )

    // The script runs in its own worker thread, so a script that is busy in
    // JavaScript can still be stopped. Tool calls are sent back here and run
    // as before.
    yield* Effect.gen(function* () {
      const source = prepareScript(opts.script)
      const settled = yield* Deferred.make<void>()
      const worker = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Worker(workerSource, {
              eval: true,
              workerData: {
                source,
                tools: [...toolNames, ...Object.keys(opts.loopTools ?? {})],
              } satisfies WorkerData,
            }),
        ),
        (worker) => Effect.promise(() => worker.terminate()),
      )

      // Every call is answered, interrupted ones included: the worker only
      // reports Done once nothing is outstanding. While the script is being
      // stopped the worker is already gone and the answer is dropped.
      const respond = (id: number, exit: Exit.Exit<unknown, unknown>) => {
        const message: ToWorker = Exit.isSuccess(exit)
          ? { id, ok: true, value: exit.value }
          : { id, ok: false, failure: toFailure(Cause.squash(exit.cause)) }
        try {
          // oxlint-disable-next-line unicorn/require-post-message-target-origin
          worker.postMessage(message)
        } catch (error) {
          // The value cannot be copied to the worker.
          // oxlint-disable-next-line unicorn/require-post-message-target-origin
          worker.postMessage({ id, ok: false, failure: toFailure(error) })
        }
      }

      const call = (message: Extract<FromWorker, { _tag: "Call" }>) => {
        const entry = toolEntries.get(message.name)
        const runFork = Effect.runForkWith(
          Context.add(
            entry ? Context.merge(entry.services, taskServices) : taskServices,
            CurrentDirectory,
            currentDirectory,
          ),
        )
        const fiber = trackFiber(
          runFork(
            entry
              ? entry.handler(message.params, {})
              : // A loop-side tool: its failure is the script's error message.
                opts.loopTools![message.name]!(message.params).pipe(
                  Effect.catch((message) => Effect.die(new Error(message))),
                ),
          ),
        )
        fiber.addObserver((exit) => respond(message.id, exit))
      }

      worker.on("message", (message: FromWorker) => {
        switch (message._tag) {
          case "Output":
            Queue.offerUnsafe(output, message.text)
            break
          case "Call":
            call(message)
            break
          case "Done":
            Deferred.doneUnsafe(settled, Effect.void)
            break
          case "Failed":
            Deferred.doneUnsafe(
              settled,
              Effect.die(fromFailure(message.failure)),
            )
            break
        }
      })
      // Bridge failures end the script instead of leaving it pending.
      worker.on("error", (error) => {
        Deferred.doneUnsafe(settled, Effect.die(error))
      })
      worker.on("messageerror", (error) => {
        Deferred.doneUnsafe(settled, Effect.die(error))
      })
      worker.on("exit", (code) => {
        Deferred.doneUnsafe(
          settled,
          Effect.die(
            new Error(`The script worker exited with code ${code} early`),
          ),
        )
      })

      yield* Deferred.await(settled)
    }).pipe(
      // Stops the worker on every exit: done, failed, timed out, interrupted.
      Effect.scoped,
      Option.isSome(scriptTimeout)
        ? Effect.timeoutOrElse({
            duration: scriptTimeout.value,
            orElse: () =>
              Queue.offer(
                output,
                `\nScript timed out: it reached its ${Duration.toMillis(scriptTimeout.value)}ms limit and was stopped. Pending tool calls were cancelled.\n`,
              ),
          })
        : identity,
      // Interrupts the tool calls still running, and the processes they own.
      Effect.ensuring(Scope.close(handlerScope, Exit.void)),
      Effect.catchCause(Effect.logFatal),
      Effect.provideService(Console.Console, console),
      // Before the output ends, so the caller has it once the stream is done.
      Effect.ensuring(
        Effect.suspend(() => opts.onEnvironment(currentEnvironment())),
      ),
      Effect.ensuring(Queue.end(output)),
      Effect.forkScoped,
    )

    return Stream.fromQueue(output)
  }, Stream.unwrap)

  const executor = AgentExecutor.of({
    capabilities: Effect.gen(function* () {
      const startup = yield* discoverAt(startupDirectory)
      const skills = offersSkills
        ? yield* AgentSkills.discover({
            directory: options.directory,
            homeDirectory: home,
            hermesHome: Option.fromNullishOr(process.env.HERMES_HOME),
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, pathService),
          )
        : []
      return new Capabilities({
        toolsDts,
        instructions: Option.map(
          Option.fromNullishOr(startup.instructions.at(-1)),
          AgentEnvironment.renderInstructions,
        ),
        supportsSearch: hasSearch,
        environment: new ExecutionEnvironment({
          cwd: startupDirectory,
          baseline: [
            ...startup.instructions.map((item) => item.id),
            ...skills.map(AgentEnvironment.skillId),
          ],
          seen: [],
        }),
        tools: Object.keys(tools.tools),
        skills,
      })
    }),
    execute: (opts) => execute(opts),
    renderEnvironment,
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

        const cwd = (opts.environment ?? startupEnvironment).cwd
        const taskServices = handler.context.pipe(
          Context.add(TaskCompleter, () => Effect.void),
          Context.add(CurrentDirectory, cwd),
          Context.add(DirectoryChanger, (directory) =>
            resolveDirectory(cwd, directory),
          ),
          Context.add(SubagentExecutor, subagentsUnavailable),
          // Direct tool calls have no model turn to attach images to.
          Context.add(ImageAttacher, () => Effect.void),
          Context.add(CommandLimits, commandLimits),
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

  return { executor, execute, renderEnvironment }
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
      Scope.Scope.useSync((scope) => {
        // Every change is recorded here before the server is told it arrived,
        // so this is current even when the stream is interrupted early.
        let latest = opts.environment
        return client
          .execute({
            script: opts.script,
            environment: opts.environment,
            loopTools: Object.keys(opts.loopTools ?? {}),
          })
          .pipe(
            Stream.tap((part) => {
              switch (part._tag) {
                case "Text": {
                  return Effect.void
                }
                case "Request": {
                  const id = part.id
                  if (part.request._tag === "EnvironmentChanged") {
                    latest = part.request.environment
                  }
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
                case "Environment": {
                  latest = part.environment
                  return Effect.void
                }
              }
            }),
            Stream.orDie,
            Stream.filterMap((part) =>
              part._tag === "Text"
                ? Result.succeed(part.text)
                : Result.failVoid,
            ),
            Stream.ensuring(Effect.suspend(() => opts.onEnvironment(latest))),
          )
      }).pipe(Stream.unwrap),
    renderEnvironment: (environment, options) =>
      client
        .renderEnvironment({ environment, reset: options?.reset ?? false })
        .pipe(Effect.orDie),
    executeUnsafe({ environment, ...options }) {
      return client
        .executeUnsafe(
          environment === undefined ? options : { ...options, environment },
        )
        .pipe(Effect.orDie)
    },
  })
})

/**
 * @since 1.0.0
 * @category Layers
 */
export const layerLocal = <Toolkit extends Toolkit.Any = never>(
  options: LocalOptions<Toolkit>,
): Layer.Layer<
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
  Layer.effect(AgentExecutor, withBuiltInHandlers(makeLocal(options))).pipe(
    Layer.provide(ToolkitRenderer.layer),
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
export const layerRpcServer = <Toolkit extends Toolkit.Any = never>(
  options: LocalOptions<Toolkit>,
): Layer.Layer<
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
          const local = yield* withBuiltInHandlers(makeLocalWith(options))
          const requestResumes = new Map<
            number,
            (effect: Effect.Effect<unknown, string>) => void
          >()
          let requestId = 0

          return Rpcs.of({
            capabilities: () => local.executor.capabilities,
            renderEnvironment: ({ environment, reset }) =>
              local.renderEnvironment(environment, { reset }),
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
            execute: Effect.fnUntraced(function* ({
              script,
              environment,
              loopTools,
            }) {
              const queue = yield* Queue.unbounded<
                typeof ExecuteOutput.Type,
                Cause.Done
              >()
              // Sends a request to the client and waits for its response.
              // IDs come from a server-wide counter, so concurrent and nested
              // execute streams never collide.
              // The client answers with the value of the matching callback.
              const request = <A>(request: typeof AgentRequest.Type) =>
                Effect.callback<A, string>((resume) => {
                  const id = requestId++
                  requestResumes.set(
                    id,
                    resume as (effect: Effect.Effect<unknown, string>) => void,
                  )
                  Queue.offerUnsafe(queue, { _tag: "Request", id, request })
                  return Effect.sync(() => {
                    requestResumes.delete(id)
                  })
                })
              yield* pipe(
                local.execute(
                  {
                    script,
                    environment,
                    onEnvironment: (environment) =>
                      Queue.offer(queue, { _tag: "Environment", environment }),
                    onTaskComplete: (summary) =>
                      request<void>({ _tag: "TaskComplete", summary }),
                    subagents: {
                      delegate: (options) =>
                        Effect.orDie(
                          request<DelegateResult>({
                            _tag: "Delegate",
                            ...options,
                          }),
                        ),
                      waitAgents: (ids) =>
                        request<ReadonlyArray<SubagentResult>>({
                          _tag: "WaitAgents",
                          ids,
                        }),
                      messageAgent: (options) =>
                        request<SubagentResult>({
                          _tag: "MessageAgent",
                          ...options,
                        }),
                      stopAgent: (id) =>
                        request<SubagentResult>({ _tag: "StopAgent", id }),
                      listAgents: Effect.orDie(
                        request<ReadonlyArray<SubagentInfo>>({
                          _tag: "ListAgents",
                        }),
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
                    loopTools: Object.fromEntries(
                      loopTools.map((name) => [
                        name,
                        (params: unknown) =>
                          toJson(name, params).pipe(
                            Effect.flatMap((params) =>
                              request<unknown>({
                                _tag: "LoopTool",
                                name,
                                params,
                              }),
                            ),
                          ),
                      ]),
                    ),
                  },
                  // Waits for the client to record the change, so a script
                  // that got past `changeDirectory` never leaves it behind.
                  (environment) =>
                    Effect.orDie(
                      request<void>({
                        _tag: "EnvironmentChanged",
                        environment,
                      }),
                    ),
                ),
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
              return local.executor.executeUnsafe(opts as any)
            },
          })
        }),
      ),
    ),
    Layer.provide(ToolkitRenderer.layer),
  )

/**
 * @since 1.0.0
 * @category Rpcs
 */
export const AgentRequest = Schema.TaggedUnion({
  TaskComplete: { summary: Schema.String },
  Delegate: {
    prompt: Schema.String,
    background: Schema.Boolean,
    environment: EnvironmentUpdate,
  },
  WaitAgents: { ids: Schema.UndefinedOr(Schema.Array(Schema.String)) },
  MessageAgent: { id: Schema.String, message: Schema.String },
  StopAgent: { id: Schema.String },
  ListAgents: {},
  LoopTool: { name: Schema.String, params: Schema.optional(Schema.Json) },
  /**
   * The script changed its environment. The client records it before it
   * responds.
   */
  EnvironmentChanged: { environment: ExecutionEnvironment },
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
  /**
   * Sent once, when the script ends. Changes before then are sent as
   * `EnvironmentChanged` requests.
   */
  Environment: { environment: ExecutionEnvironment },
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
      environment: ExecutionEnvironment,
      /**
       * The loop-side tools to add to the script sandbox.
       */
      loopTools: Schema.Array(Schema.String).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed([])),
      ),
    }),
    success: ExecuteOutput,
    stream: true,
  }),
  Rpc.make("renderEnvironment", {
    payload: { environment: ExecutionEnvironment, reset: Schema.Boolean },
    success: EnvironmentUpdate,
  }),
  Rpc.make("executeUnsafe", {
    payload: Schema.Struct({
      tool: Schema.String,
      params: Schema.Json,
      environment: Schema.optionalKey(ExecutionEnvironment),
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
      return opts.subagents.delegate(request)
    case "WaitAgents":
      return opts.subagents.waitAgents(request.ids)
    case "MessageAgent":
      return opts.subagents.messageAgent(request)
    case "StopAgent":
      return opts.subagents.stopAgent(request.id)
    case "ListAgents":
      return opts.subagents.listAgents
    case "EnvironmentChanged":
      // Recorded by the client before it responds.
      return Effect.void
    case "LoopTool": {
      const handler = opts.loopTools?.[request.name]
      return handler
        ? handler(request.params)
        : Effect.fail(`Unknown loop-side tool: ${request.name}`)
    }
  }
}

// Script arguments cross the RPC boundary as JSON.
const toJson = (
  name: string,
  params: unknown,
): Effect.Effect<Schema.Json | undefined, string> =>
  Effect.try({
    try: () => {
      const json = JSON.stringify(params)
      return json === undefined ? undefined : (JSON.parse(json) as Schema.Json)
    },
    catch: (error) => `Invalid arguments for ${name}: ${errorMessage(error)}`,
  })

// The built-in handlers sit underneath the caller's context, so a caller tool
// named like a built-in keeps its own handler.
const withBuiltInHandlers = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E,
  | Exclude<R, Tool.HandlersFor<typeof AgentToolsWithSearch.tools>>
  | Scope.Scope
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
> =>
  Effect.flatMap(Layer.build(AgentToolHandlers), (builtIns) =>
    Effect.updateContext(
      effect,
      (context: Context.Context<never>) =>
        Context.merge(builtIns, context) as Context.Context<R>,
    ),
  ) as any

const exitToResponse = (
  exit: Exit.Exit<unknown, string>,
): typeof AgentResponse.Type => {
  if (Exit.isSuccess(exit)) {
    return { _tag: "Success", value: (exit.value ?? null) as Schema.Json }
  }
  return { _tag: "Failure", message: errorMessage(Cause.squash(exit.cause)) }
}

const errorMessage = (error: unknown): string =>
  typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : String(error)

// Leaving out `delegate` leaves out the tools that address its sub-agents.
const excludedToolNames = (
  excludeTools: ReadonlyArray<ExcludableTool> | undefined,
): ReadonlySet<string> => {
  const names = new Set<string>(excludeTools)
  if (names.has("delegate")) {
    for (const name of [
      "waitAgents",
      "messageAgent",
      "stopAgent",
      "listAgents",
    ]) {
      names.add(name)
    }
  }
  return names
}

const wrapScript = (script: string): string => `async function main() {
${script}
}`

/**
 * Returns source that compiles, preprocessing the script if it has syntax
 * errors. Throws the original syntax error if neither version compiles.
 */
const prepareScript = (script: string): string => {
  const source = wrapScript(script)
  try {
    // Compiled only to check the syntax. The worker compiles it again.
    // oxlint-disable-next-line eslint/no-new
    new NodeVm.Script(source)
    return source
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error
    }

    const preprocessed = preprocessScript(script)
    if (preprocessed === script) {
      throw error
    }

    const preprocessedSource = wrapScript(preprocessed)
    try {
      // oxlint-disable-next-line eslint/no-new
      new NodeVm.Script(preprocessedSource)
      return preprocessedSource
    } catch {
      throw error
    }
  }
}

interface WorkerData {
  readonly source: string
  readonly tools: ReadonlyArray<string>
}

/**
 * A rejection crossing the worker boundary. Errors keep their name, message
 * and stack. Other values are copied, or turned into a string when they
 * cannot be.
 */
type Failure =
  | {
      readonly _tag: "Error"
      readonly name: string
      readonly message: string
      readonly stack: string | undefined
    }
  | { readonly _tag: "Value"; readonly value: unknown }

type FromWorker =
  | { readonly _tag: "Output"; readonly text: string }
  | {
      readonly _tag: "Call"
      readonly id: number
      readonly name: string
      readonly params: unknown
    }
  | { readonly _tag: "Done" }
  | { readonly _tag: "Failed"; readonly failure: Failure }

type ToWorker =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly failure: Failure }

// -------------------------------------------
// Script worker
//
// The worker runs from source text (`new Worker(source, { eval: true })`), so
// it needs no separate file in the package, the CLI bundle or a consumer's
// bundle. The source is built from the function declarations below with
// `Function.prototype.toString`, which keeps them type-checked and shared
// with the parent instead of copied into a string.
//
// Constraints, because the text of each function must run on its own:
// - Each must be a `function` declaration, so its text carries its name.
// - They may reference only each other, their parameters and globals: no
//   imports, module-level values or closures.
// - Node modules are loaded with the `load` parameter, which the source text
//   binds to the worker's `require`. Bundlers rewrite a bare `require` (the
//   CLI bundle turns it into `__require`), but leave a parameter alone.
// - A bundler must keep their bodies whole. Renaming identifiers
//   consistently is fine. Transforms that move code out of a body, such as
//   coverage instrumentation or helper hoisting, are not. Only the
//   library build and the CLI bundle are checked.
// The executor tests run every script through this worker, so they catch a
// broken constraint in the source. They run the source, not a bundle, so a
// bundler's rewrites only show up when the built output is run.
// -------------------------------------------

function toFailure(value: unknown): Failure {
  if (Object.prototype.toString.call(value) === "[object Error]") {
    const error = value as Error
    return {
      _tag: "Error",
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }
  try {
    return { _tag: "Value", value: structuredClone(value) }
  } catch {
    return { _tag: "Value", value: String(value) }
  }
}

function fromFailure(failure: Failure): unknown {
  if (failure._tag === "Value") return failure.value
  const error = new Error(failure.message)
  error.name = failure.name
  if (failure.stack !== undefined) error.stack = failure.stack
  return error
}

/**
 * Runs one script inside a vm context with the same globals as before, and
 * forwards console output and tool calls to the parent.
 */
function runScriptWorker(load: (id: string) => unknown): void {
  // Type-only references: the casts are erased, so the text stays
  // self-contained.
  const { parentPort, workerData } = load(
    "node:worker_threads",
  ) as typeof NodeWorkerThreads
  const vm = load("node:vm") as typeof NodeVm
  const { Console } = load("node:console") as typeof NodeConsole
  const { Writable: WorkerWritable } = load("node:stream") as {
    readonly Writable: typeof Writable
  }
  const port = parentPort!
  const data = workerData as WorkerData

  // Like the parent process: a stray rejection must not end the script.
  process.on("uncaughtException", () => {})
  process.on("unhandledRejection", () => {})

  const post = (message: FromWorker) => port.postMessage(message)

  const pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void
      readonly reject: (error: unknown) => void
    }
  >()
  let nextId = 0
  let mainSettled = false
  let done = false
  // Done once main() has settled and no tool call is outstanding. The check
  // runs after the microtasks a result triggers, so a continuation that
  // calls another tool is waited for too. Done is sent once.
  const maybeDone = () => {
    if (done || !mainSettled || pending.size > 0) return
    setImmediate(() => {
      if (done || pending.size > 0) return
      done = true
      post({ _tag: "Done" })
    })
  }
  port.on("message", (message: ToWorker) => {
    const call = pending.get(message.id)
    if (call === undefined) return
    pending.delete(message.id)
    if (message.ok) call.resolve(message.value)
    else call.reject(fromFailure(message.failure))
    maybeDone()
  })

  const stdout = new WorkerWritable({
    write(chunk, _encoding, callback) {
      post({ _tag: "Output", text: String(chunk) })
      callback()
    },
  })

  const sandbox: Record<string, unknown> = {
    console: new Console({ stdout, colorMode: false }),
    fetch,
    process: undefined,
  }
  for (const name of data.tools) {
    sandbox[name] = (params: unknown) =>
      new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        try {
          post({ _tag: "Call", id, name, params })
        } catch (error) {
          // The params cannot be copied to the parent.
          pending.delete(id)
          reject(error)
          maybeDone()
        }
      })
  }

  new vm.Script(data.source).runInNewContext(sandbox)
  ;(sandbox.main as () => Promise<void>)().then(
    () => {
      mainSettled = true
      maybeDone()
    },
    (error) => post({ _tag: "Failed", failure: toFailure(error) }),
  )
}

const workerSource = `${toFailure}
${fromFailure}
(${runScriptWorker})(require)
`

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

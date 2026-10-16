import { assert, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpEffect from "effect/http/HttpEffect"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import type { Worker } from "node:worker_threads"
import * as AgentExecutor from "./AgentExecutor.ts"
import { subagentsUnavailable } from "./AgentTools.ts"

// Unlike the built-in tools, this tool sends no log line: starting a tool
// must not accidentally turn the no-output case into the passing control.
const Tools = Toolkit.make(
  Tool.make("silentProbe", { parameters: Schema.Void, success: Schema.Void }),
)

for (const firstOutput of [false, true]) {
  it.live(
    `RPC interruption cleans up ${firstOutput ? "after" : "before"} first output`,
    () =>
      Effect.gen(function* () {
        const started =
          yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>()
        const stopped = yield* Deferred.make<void>()
        const workerStarted = yield* Deferred.make<Worker>()
        const workerExited = yield* Deferred.make<void>()
        const onWorker = (worker: Worker) => {
          Deferred.doneUnsafe(workerStarted, Effect.succeed(worker))
          worker.once("exit", () =>
            Deferred.doneUnsafe(workerExited, Effect.void),
          )
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => process.once("worker", onWorker)),
          () =>
            Effect.sync(() => {
              process.removeListener("worker", onWorker)
            }),
        )
        const fs = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const directory = yield* fs.makeTempDirectoryScoped()
        const { protocol, httpEffect } =
          yield* RpcServer.makeProtocolWithHttpEffect()
        yield* Layer.build(
          AgentExecutor.layerRpcServer({ directory, tools: Tools }).pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(Layer.succeed(RpcServer.Protocol, protocol)),
            Layer.provide(
              Tools.toLayer({
                silentProbe: () =>
                  Effect.gen(function* () {
                    // A real process owned by the pending tool, with its own watchdog.
                    const child = yield* spawner.spawn(
                      ChildProcess.make("sleep", ["5"]),
                    )
                    yield* Deferred.succeed(started, child)
                    return yield* Effect.never
                  }).pipe(
                    Effect.scoped,
                    Effect.ensuring(Deferred.succeed(stopped, undefined)),
                    Effect.orDie,
                  ),
              }),
            ),
          ),
        )
        const handler = HttpEffect.toWebHandler(httpEffect)
        let responseStarted = false
        let requestSignal: AbortSignal | undefined
        const client = AgentExecutor.layerRpc.pipe(
          Layer.provide(
            RpcClient.layerProtocolHttp({ url: "http://executor.test/" }),
          ),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(
            Layer.succeed(FetchHttpClient.Fetch, async (input, init) => {
              const request = new Request(input, init)
              requestSignal = request.signal
              const response = await handler(request)
              responseStarted = true
              return response
            }),
          ),
        )
        yield* Effect.gen(function* () {
          const executor = yield* AgentExecutor.AgentExecutor
          const { environment } = yield* executor.capabilities
          responseStarted = false
          const output: Array<string> = []
          const execute = (script: string) =>
            executor.execute({
              script,
              environment,
              onEnvironment: () => Effect.void,
              onTaskComplete: () => Effect.void,
              onImage: () => Effect.void,
              subagents: subagentsUnavailable,
            })
          const fiber = yield* execute(`
${firstOutput ? 'console.log("ready")' : ""}
silentProbe()
const giveUp = Date.now() + 5000
while (Date.now() < giveUp) {}
`).pipe(
            Stream.runForEach((text) =>
              Effect.sync(() => {
                output.push(text)
              }),
            ),
            Effect.forkScoped,
          )
          const child = yield* Deferred.await(started)
          const worker = yield* Deferred.await(workerStarted)
          const cpuBefore = yield* Effect.promise(() => worker.cpuUsage())
          yield* Effect.sleep("150 millis")
          const cpuBusy = yield* Effect.promise(() =>
            worker.cpuUsage(cpuBefore),
          )
          assert.isAbove(
            cpuBusy.user + cpuBusy.system,
            20_000,
            "worker is busy",
          )
          assert.strictEqual(
            responseStarted,
            firstOutput,
            "response has started",
          )
          yield* Fiber.interrupt(fiber)
          yield* Effect.all([
            Deferred.await(stopped),
            Deferred.await(workerExited),
          ]).pipe(Effect.timeoutOption("500 millis"))
          assert.isTrue(requestSignal?.aborted, "HTTP request was aborted")
          // An exited worker cannot consume CPU; querying it must reject. This
          // avoids flaky process-wide CPU thresholds when other tests run.
          const cpuStopped = yield* Effect.promise(() =>
            worker.cpuUsage().then(
              () => false,
              (error) => error.code === "ERR_WORKER_NOT_RUNNING",
            ),
          )
          // Observe before closing either layer, and still try a later execute
          // even when cleanup failed. Teardown must not make the assertions pass.
          const cleanup = {
            cpuStopped,
            workerExited: yield* Deferred.isDone(workerExited),
            toolStopped: yield* Deferred.isDone(stopped),
            processRunning: yield* child.isRunning,
          }
          const later = yield* execute('console.log("still works")').pipe(
            Stream.mkString,
          )
          assert.include(later, "still works")
          assert.strictEqual(output.join(""), firstOutput ? "ready\n" : "")
          assert.deepEqual(cleanup, {
            cpuStopped: true,
            workerExited: true,
            toolStopped: true,
            processRunning: false,
          })
        }).pipe(Effect.provide(client))
      }).pipe(
        Effect.scoped,
        Effect.timeout("10 seconds"),
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, RpcSerialization.layerNdjson),
        ),
      ),
    15_000,
  )
}

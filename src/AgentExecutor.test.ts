import { assert, describe, it } from "@effect/vitest"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpEffect from "effect/http/HttpEffect"
import * as HttpServer from "effect/http/HttpServer"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as AgentExecutor from "./AgentExecutor.ts"
import { subagentsUnavailable } from "./AgentTools.ts"

const withRpc = <A, E, R>(
  f: (
    executor: AgentExecutor.AgentExecutor["Service"],
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const { protocol, httpEffect } =
      yield* RpcServer.makeProtocolWithHttpEffect()
    yield* Layer.build(
      AgentExecutor.layerRpcServer({ directory }).pipe(
        Layer.provide(Layer.succeed(RpcServer.Protocol, protocol)),
      ),
    )
    yield* HttpServer.serveEffect(httpEffect)
    return yield* Effect.gen(function* () {
      const executor = yield* AgentExecutor.AgentExecutor
      return yield* f(executor).pipe(Effect.timeout("2 seconds"))
    }).pipe(
      Effect.provide(
        AgentExecutor.layerRpc.pipe(
          Layer.provide(RpcClient.layerProtocolHttp({ url: "" })),
        ),
      ),
    )
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        RpcSerialization.layerNdjson,
        NodeHttpServer.layerTest,
        NodeServices.layer,
      ),
    ),
    Effect.scoped,
  )

describe("RPC subagent executor", () => {
  it.live("routes concurrent delegates to their originating scripts", () =>
    withRpc((executor) =>
      Effect.gen(function* () {
        const { environment } = yield* executor.capabilities
        const firstStarted = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const outputs = yield* Effect.all(
          [
            executor
              .execute({
                environment,
                onEnvironment: () => Effect.void,
                script:
                  'console.log("first:" + (await delegate({ prompt: "first" })).output)',
                onTaskComplete: () => Effect.void,
                onImage: () => Effect.void,
                subagents: {
                  ...subagentsUnavailable,
                  delegate: ({ prompt }) =>
                    Effect.gen(function* () {
                      assert.strictEqual(prompt, "first")
                      yield* Deferred.succeed(firstStarted, undefined)
                      yield* Deferred.await(secondStarted)
                      return {
                        id: "1",
                        status: "completed" as const,
                        output: "first-output",
                      }
                    }),
                },
              })
              .pipe(Stream.runCollect),
            executor
              .execute({
                environment,
                onEnvironment: () => Effect.void,
                script:
                  'console.log("second:" + (await delegate({ prompt: "second" })).output)',
                onTaskComplete: () => Effect.void,
                onImage: () => Effect.void,
                subagents: {
                  ...subagentsUnavailable,
                  delegate: ({ prompt }) =>
                    Effect.gen(function* () {
                      assert.strictEqual(prompt, "second")
                      yield* Deferred.succeed(secondStarted, undefined)
                      yield* Deferred.await(firstStarted)
                      return {
                        id: "2",
                        status: "completed" as const,
                        output: "second-output",
                      }
                    }),
                },
              })
              .pipe(Stream.runCollect),
          ],
          { concurrency: "unbounded" },
        )
        assert.isTrue(outputs[0].join("").endsWith("first:first-output\n"))
        assert.isTrue(outputs[1].join("").endsWith("second:second-output\n"))
      }),
    ),
  )

  it.live(
    "completes nested delegation while the parent stream is waiting",
    () =>
      withRpc((executor) =>
        Effect.gen(function* () {
          const { environment } = yield* executor.capabilities
          const output = yield* executor
            .execute({
              environment,
              onEnvironment: () => Effect.void,
              script:
                'console.log("parent:" + (await delegate({ prompt: "outer" })).output)',
              onTaskComplete: () => Effect.void,
              onImage: () => Effect.void,
              subagents: {
                ...subagentsUnavailable,
                delegate: ({ prompt }) =>
                  Effect.gen(function* () {
                    assert.strictEqual(prompt, "outer")
                    const childOutput = yield* executor
                      .execute({
                        environment,
                        onEnvironment: () => Effect.void,
                        script:
                          'console.log("child:" + (await delegate({ prompt: "inner" })).output)',
                        onTaskComplete: () => Effect.void,
                        onImage: () => Effect.void,
                        subagents: {
                          ...subagentsUnavailable,
                          delegate: ({ prompt: innerPrompt }) =>
                            Effect.sync(() => {
                              assert.strictEqual(innerPrompt, "inner")
                              return {
                                id: "2",
                                status: "completed" as const,
                                output: "inner-output",
                              }
                            }),
                        },
                      })
                      .pipe(Stream.runCollect)
                    assert.isTrue(
                      childOutput.join("").endsWith("child:inner-output\n"),
                    )
                    return {
                      id: "1",
                      status: "completed" as const,
                      output: childOutput.join("").trim().split("\n").at(-1)!,
                    }
                  }),
              },
            })
            .pipe(Stream.runCollect)
          assert.isTrue(output.join("").endsWith("parent:child:inner-output\n"))
        }),
      ),
  )
})

// Both executor modes with the same limits. The RPC mode serves
// `layerRpcServer` through an in-memory web handler, so requests go through
// the real serialization without opening a socket.
const executorModes = {
  local: (limits: AgentExecutor.Limits) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        return AgentExecutor.layerLocal({ directory, limits })
      }),
    ).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  rpc: (limits: AgentExecutor.Limits) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const { protocol, httpEffect } =
          yield* RpcServer.makeProtocolWithHttpEffect()
        yield* Layer.build(
          AgentExecutor.layerRpcServer({ directory, limits }).pipe(
            Layer.provide(Layer.succeed(RpcServer.Protocol, protocol)),
            Layer.provide(FetchHttpClient.layer),
          ),
        )
        const handler = HttpEffect.toWebHandler(httpEffect)
        return AgentExecutor.layerRpc.pipe(
          Layer.provide(
            RpcClient.layerProtocolHttp({ url: "http://executor.test/" }),
          ),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(
            Layer.succeed(FetchHttpClient.Fetch, (input, init) =>
              handler(new Request(input, init)),
            ),
          ),
        )
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(NodeServices.layer, RpcSerialization.layerNdjson),
      ),
    ),
}

const runScript = (script: string) =>
  Effect.gen(function* () {
    const executor = yield* AgentExecutor.AgentExecutor
    const { environment } = yield* executor.capabilities
    return yield* executor
      .execute({
        environment,
        onEnvironment: () => Effect.void,
        script,
        onTaskComplete: () => Effect.void,
        subagents: subagentsUnavailable,
        onImage: () => Effect.void,
      })
      .pipe(Stream.mkString)
  })

// Puts a `gh` that only sleeps first on PATH, so the test needs neither the
// real CLI nor the network.
const withSlowGh = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const directory = NodeFs.mkdtempSync(
        NodePath.join(NodeOs.tmpdir(), "slow-gh-"),
      )
      const gh = NodePath.join(directory, "gh")
      NodeFs.writeFileSync(gh, "#!/bin/sh\nsleep 10\n")
      NodeFs.chmodSync(gh, 0o755)
      const path = process.env.PATH
      process.env.PATH = `${directory}${NodePath.delimiter}${path}`
      return { directory, path }
    }),
    () => effect,
    ({ directory, path }) =>
      Effect.sync(() => {
        process.env.PATH = path
        NodeFs.rmSync(directory, { recursive: true, force: true })
      }),
  )

for (const [mode, executorLayer] of Object.entries(executorModes)) {
  describe(`${mode} executor environment`, () => {
    // A cancelled script keeps the directory it changed to, as an ACP
    // `session/cancel` or a `stopAgent` continues the same agent afterwards.
    it.live("returns the environment when the caller interrupts", () =>
      Effect.gen(function* () {
        const executor = yield* AgentExecutor.AgentExecutor
        const { environment } = yield* executor.capabilities
        const ready = yield* Deferred.make<void>()
        const updates: Array<AgentExecutor.EnvironmentUpdate> = []
        const fiber = yield* executor
          .execute({
            script: `await changeDirectory("..")
console.log("ready")
await sleep(60000)`,
            environment,
            onEnvironment: (update) =>
              Effect.sync(() => {
                updates.push(update)
              }),
            onTaskComplete: () => Effect.void,
            subagents: subagentsUnavailable,
            onImage: () => Effect.void,
          })
          .pipe(
            Stream.runForEach((text) =>
              text.includes("ready")
                ? Deferred.succeed(ready, undefined)
                : Effect.void,
            ),
            Effect.forkScoped,
          )
        yield* Deferred.await(ready)
        yield* Fiber.interrupt(fiber)
        assert.strictEqual(updates.length, 1)
        assert.strictEqual(
          updates[0]!.environment.cwd,
          NodePath.dirname(environment.cwd),
        )
      }).pipe(
        Effect.scoped,
        Effect.timeout("5 seconds"),
        Effect.provide(executorLayer({})),
      ),
    )
  })

  describe(`${mode} executor limits`, () => {
    it.live("stops a bash command at the caller's command timeout", () =>
      Effect.gen(function* () {
        const output = yield* runScript(`
try {
  await bash({ command: 'sleep 10 && echo fini""shed', timeoutMs: 60000 })
} catch (error) {
  console.log("REJECTED:", String(error))
}`)
        assert.include(output, "REJECTED:")
        assert.match(output, /timed out/i)
        assert.notInclude(output, "finished")
      }).pipe(
        Effect.timeout("3 seconds"),
        Effect.provide(executorLayer({ commandTimeout: "300 millis" })),
      ),
    )

    it.live("stops a gh command at the caller's command timeout", () =>
      Effect.gen(function* () {
        const output = yield* runScript(`
try {
  await gh(["api", "user"])
  console.log("GH" + "_RETURNED")
} catch (error) {
  console.log("REJECTED:", String(error))
}`)
        assert.include(output, "REJECTED:")
        assert.match(output, /timed out/i)
        assert.notInclude(output, "GH_RETURNED")
      }).pipe(
        Effect.timeout("3 seconds"),
        Effect.provide(executorLayer({ commandTimeout: "300 millis" })),
        withSlowGh,
      ),
    )

    it.live("describes the caller's command timeout to the model", () =>
      Effect.gen(function* () {
        const executor = yield* AgentExecutor.AgentExecutor
        const { toolsDts } = yield* executor.capabilities
        assert.include(toolsDts, "180000")
        assert.notInclude(toolsDts, "120000")
        assert.notInclude(toolsDts, "4 minutes")
      }).pipe(Effect.provide(executorLayer({ commandTimeout: "3 minutes" }))),
    )

    it.live("ends a script at the caller's script timeout", () =>
      Effect.gen(function* () {
        const output = yield* runScript(`
console.log("before")
await sleep(10000)
console.log("after")`)
        assert.include(output, "before")
        assert.notInclude(output, "after")
        assert.match(output, /timed out/i)
      }).pipe(
        Effect.timeout("3 seconds"),
        Effect.provide(executorLayer({ scriptTimeout: "300 millis" })),
      ),
    )

    // The busy loop is the watchdog: it gives up after 2 seconds, so a
    // regression fails the assertions instead of hanging the test runner.
    it.live(
      "ends a script that is busy in JavaScript at the script timeout",
      () =>
        Effect.gen(function* () {
          const output = yield* runScript(`
await sleep(1)
const giveUp = Date.now() + 2000
while (Date.now() < giveUp) {}
console.log("BUSY" + "_LOOP_FINISHED")`)
          assert.notInclude(output, "BUSY_LOOP_FINISHED")
          assert.match(output, /timed out/i)
        }).pipe(
          Effect.timeout("5 seconds"),
          Effect.provide(executorLayer({ scriptTimeout: "300 millis" })),
        ),
    )

    it.live("runs tool calls chained after the script returns", () =>
      Effect.gen(function* () {
        const output = yield* runScript(`
sleep(100).then(() => {
  console.log("FIRST" + "_CONTINUATION")
  return sleep(100).then(() => console.log("SECOND" + "_CONTINUATION"))
})
console.log("MAIN" + "_DONE")`)
        assert.include(output, "MAIN_DONE")
        assert.include(output, "FIRST_CONTINUATION")
        assert.include(output, "SECOND_CONTINUATION")
      }).pipe(Effect.timeout("3 seconds"), Effect.provide(executorLayer({}))),
    )

    // The timeout is the watchdog: a script left waiting fails the test.
    it.live(
      "ends a script whose worker exits while a tool call is running",
      () =>
        Effect.gen(function* () {
          const executor = yield* AgentExecutor.AgentExecutor
          const { environment } = yield* executor.capabilities
          const output = yield* executor
            .execute({
              environment,
              onEnvironment: () => Effect.void,
              // `delegate` never finishes. The worker then exits through
              // the host's `process`, the way a crashed worker would.
              script: `
delegate({ prompt: "never finishes" })
sleep(100).then(() => console.constructor.constructor("return process")().exit(7))`,
              onTaskComplete: () => Effect.void,
              subagents: {
                ...subagentsUnavailable,
                delegate: () => Effect.never,
              },
              onImage: () => Effect.void,
            })
            .pipe(Stream.mkString)
          assert.include(output, "code 7")
        }).pipe(Effect.timeout("3 seconds"), Effect.provide(executorLayer({}))),
    )

    it.live("keeps the start and end of long bash output", () =>
      Effect.gen(function* () {
        const executor = yield* AgentExecutor.AgentExecutor
        const output = yield* executor.executeUnsafe({
          tool: "bash",
          params: { command: "seq 1 1000000" },
        })
        assert(typeof output === "string")
        assert.isBelow(output.length, 10_000 + 500)
        assert.isTrue(output.startsWith("1\n2\n3\n"), "start kept")
        assert.isTrue(output.trimEnd().endsWith("999999\n1000000"), "end kept")
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.provide(executorLayer({ commandOutputChars: 10_000 })),
      ),
    )
  })
}

import { assert, describe, it } from "@effect/vitest"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
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
  server: (
    directory: string,
  ) => ReturnType<typeof AgentExecutor.layerRpcServer> = (directory) =>
    AgentExecutor.layerRpcServer({ directory }),
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const { protocol, httpEffect } =
      yield* RpcServer.makeProtocolWithHttpEffect()
    yield* Layer.build(
      server(directory).pipe(
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

describe("RPC executeUnsafe", () => {
  it.live("writes Uint8Array writeFile content as raw bytes", () =>
    withRpc((executor) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { environment } = yield* executor.capabilities
        yield* executor.executeUnsafe({
          tool: "writeFile",
          params: { path: "data.bin", content: new Uint8Array([0, 255, 128]) },
        })
        const bytes = yield* fs.readFile(
          NodePath.join(environment.cwd, "data.bin"),
        )
        assert.deepStrictEqual(Array.from(bytes), [0, 255, 128])
      }),
    ),
  )

  it.live("accepts undefined params and undefined param properties", () =>
    withRpc((executor) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { environment } = yield* executor.capabilities
        yield* fs.writeFileString(
          NodePath.join(environment.cwd, "x.txt"),
          "hello",
        )
        const agents = yield* executor.executeUnsafe({
          tool: "listAgents",
          params: undefined,
        })
        assert.deepStrictEqual(agents, [])
        const content = yield* executor.executeUnsafe({
          tool: "readFile",
          params: { path: "x.txt", startLine: undefined, lineNumbers: false },
        })
        assert.strictEqual(content, "hello")
      }),
    ),
  )

  it.live("passes a caller's tool params shaped like bytes unchanged", () => {
    const payload = { _tag: "Bytes", base64: "AA==" } as const
    const Echo = Toolkit.make(
      Tool.make("echo", {
        parameters: Schema.Struct({
          payload: Schema.TaggedStruct("Bytes", { base64: Schema.String }),
        }),
        success: Schema.TaggedStruct("Bytes", { base64: Schema.String }),
      }),
    )
    return withRpc(
      (executor) =>
        Effect.gen(function* () {
          // `executeUnsafe` is typed for the built-in tools, but the server
          // runs the caller's tools too.
          const output = yield* executor.executeUnsafe({
            tool: "echo" as never,
            params: { payload } as never,
          })
          assert.deepStrictEqual(output, payload)
        }),
      (directory) =>
        AgentExecutor.layerRpcServer({ directory, tools: Echo }).pipe(
          Layer.provide(
            Echo.toLayer({ echo: ({ payload }) => Effect.succeed(payload) }),
          ),
        ),
    )
  })

  it.live("passes a caller's null params and __proto__ keys unchanged", () => {
    const Echo = Toolkit.make(
      Tool.make("echo", { parameters: Schema.Json, success: Schema.Json }),
    )
    return withRpc(
      (executor) =>
        Effect.gen(function* () {
          const nullOutput = yield* executor.executeUnsafe({
            tool: "echo" as never,
            params: null as never,
          })
          assert.strictEqual(nullOutput, null)
          const output = (yield* executor.executeUnsafe({
            tool: "echo" as never,
            params: JSON.parse('{"__proto__":{"x":1}}') as never,
          })) as object
          // An own `__proto__` key, not a prototype.
          assert.deepStrictEqual(Object.keys(output), ["__proto__"])
          assert.deepStrictEqual(
            Object.getOwnPropertyDescriptor(output, "__proto__")?.value,
            { x: 1 },
          )
        }),
      (directory) =>
        AgentExecutor.layerRpcServer({ directory, tools: Echo }).pipe(
          Layer.provide(
            Echo.toLayer({ echo: (params) => Effect.succeed(params) }),
          ),
        ),
    )
  })
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

const readLog = (path: string) =>
  NodeFs.existsSync(path) ? NodeFs.readFileSync(path, "utf8") : ""

// A command that records its shell's pid and logs its start, then waits for
// `openGate` before it logs its finish. The log shows whether it was killed
// or started twice, without racing a sleep.
const gatedCommand = (directory: string) => {
  const pid = NodePath.join(directory, "pid")
  const log = NodePath.join(directory, "runs.log")
  const gate = NodePath.join(directory, "gate")
  return `echo $$ > ${pid} && echo start >> ${log} && until [ -f ${gate} ]; do sleep 0.02; done && echo finish >> ${log}`
}
const openGate = (directory: string) =>
  NodeFs.writeFileSync(NodePath.join(directory, "gate"), "")

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

// Polls until the gated command's shell has exited. The kill can land after
// the caller has moved on, as an RPC interrupt does not wait for the server.
// A command that is never killed waits at its gate, so it fails the deadline.
const waitForExit = (directory: string) =>
  Effect.gen(function* () {
    const pid = Number(
      NodeFs.readFileSync(NodePath.join(directory, "pid"), "utf8"),
    )
    while (isAlive(pid)) {
      yield* Effect.sleep("20 millis")
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => Effect.die(new Error("The command was not stopped")),
    }),
  )

// Polls the log until `done` holds.
const waitForLog = (directory: string, done: (log: string) => boolean) =>
  Effect.gen(function* () {
    const path = NodePath.join(directory, "runs.log")
    while (!done(readLog(path))) {
      yield* Effect.sleep("20 millis")
    }
    return readLog(path)
  })
const started = (log: string) => log !== ""
const finished = (log: string) => log.includes("finish")

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

// Node's default `console.log` breaks values over many lines and pads short
// array entries into columns. That whitespace is paid for in every prompt.
describe("console.log in scripts", () => {
  it.live("prints arrays and objects on one line without padding", () =>
    Effect.gen(function* () {
      const output = yield* runScript(`
console.log([".changeset", ".envrc", ".git", ".github", ".gitignore", ".husky", ".oxlintrc.json", ".prettierignore", ".prettierrc.json", ".specs", "AGENTS.md", "CHANGELOG.md", "CLAUDE.md", "README.md", "examples", "flake.lock", "flake.nix", "package.json", "pnpm-lock.yaml", "scripts", "src", "tsconfig.json", "tsdown.config.ts", "vitest.config.ts"])
console.log([0, 37, 74, 111, 148, 185, 222, 259, 296, 333, 370, 407, 444, 481, 518, 555, 592, 629, 666, 703, 740, 777, 814, 851, 888, 925, 962, 999, 1036, 1073])
console.log({ name: "my-project", version: "1.0.0", scripts: { check: "oxlint -c .oxlintrc.json --fix && pnpm tsc -b tsconfig.json", test: "vitest run" } })`)
      const lines = output.trimEnd().split("\n")
      assert.strictEqual(lines.length, 3, output)
      assert.include(lines[0], "vitest.config.ts")
      assert.include(lines[1], "1073")
      assert.include(lines[2], "vitest run")
      assert.notMatch(output, / {2,}/, "no padding or indentation")
    }).pipe(
      Effect.timeout("3 seconds"),
      Effect.provide(executorModes.local({})),
    ),
  )
})

for (const [mode, executorLayer] of Object.entries(executorModes)) {
  describe(`${mode} executor environment`, () => {
    // A cancelled script keeps the directory it changed to, as an ACP
    // `session/cancel` or a `stopAgent` continues the same agent afterwards.
    it.live("returns the environment when the caller interrupts", () =>
      Effect.gen(function* () {
        const executor = yield* AgentExecutor.AgentExecutor
        const { environment } = yield* executor.capabilities
        const ready = yield* Deferred.make<void>()
        const updates: Array<AgentExecutor.ExecutionEnvironment> = []
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
        assert.strictEqual(updates[0]!.cwd, NodePath.dirname(environment.cwd))
      }).pipe(
        Effect.scoped,
        Effect.timeout("5 seconds"),
        Effect.provide(executorLayer({})),
      ),
    )

    // The caller is still busy with output from before the change when it
    // interrupts. Whatever the script got done by then, the environment
    // returned matches it: the marker shows it got past `changeDirectory`.
    it.live(
      "returns the environment when the caller interrupts while behind",
      () =>
        Effect.gen(function* () {
          const executor = yield* AgentExecutor.AgentExecutor
          const { environment } = yield* executor.capabilities
          const marker = NodePath.join(environment.cwd, "changed")
          const busy = yield* Deferred.make<void>()
          const updates: Array<AgentExecutor.ExecutionEnvironment> = []
          const fiber = yield* executor
            .execute({
              script: `console.log("before")
await sleep(50)
await changeDirectory("..")
await writeFile({ path: ${JSON.stringify(marker)}, content: "" })
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
              Stream.runForEach(() =>
                Deferred.succeed(busy, undefined).pipe(
                  Effect.andThen(Effect.never),
                ),
              ),
              Effect.forkScoped,
            )
          yield* Deferred.await(busy)
          yield* Effect.gen(function* () {
            while (!NodeFs.existsSync(marker)) {
              yield* Effect.sleep("10 millis")
            }
          }).pipe(Effect.timeoutOption("500 millis"))
          const changed = NodeFs.existsSync(marker)
          yield* Fiber.interrupt(fiber)
          assert.strictEqual(updates.length, 1)
          assert.strictEqual(
            updates[0]!.cwd,
            changed ? NodePath.dirname(environment.cwd) : environment.cwd,
          )
        }).pipe(
          Effect.scoped,
          Effect.timeout("5 seconds"),
          Effect.provide(executorLayer({})),
        ),
    )
  })

  describe(`${mode} executor limits`, () => {
    it.live("runs a bash command in the background", () =>
      Effect.gen(function* () {
        const executor = yield* AgentExecutor.AgentExecutor
        const { environment } = yield* executor.capabilities
        const output = yield* runScript(`
const result = await bash({
  command: ${JSON.stringify(gatedCommand(environment.cwd))},
  background: true,
})
console.log("RETURNED:", JSON.stringify(result))`)
        assert.include(
          output,
          'RETURNED: {"id":"1","status":"running","output":""}',
        )
        assert.strictEqual(
          yield* waitForLog(environment.cwd, started),
          "start\n",
          "still running after the script ended",
        )
        openGate(environment.cwd)
        assert.strictEqual(
          yield* waitForLog(environment.cwd, finished),
          "start\nfinish\n",
        )
      }).pipe(Effect.timeout("5 seconds"), Effect.provide(executorLayer({}))),
    )

    it.live("moves a bash command to the background at its timeout", () =>
      Effect.gen(function* () {
        const executor = yield* AgentExecutor.AgentExecutor
        const { environment } = yield* executor.capabilities
        const output = yield* runScript(`
try {
  const result = await bash({
    command: ${JSON.stringify(`echo early && ${gatedCommand(environment.cwd)}`)},
    timeoutMs: 60000,
  })
  console.log("RETURNED:", JSON.stringify(result))
} catch (error) {
  console.log("REJECTED:", String(error))
}`)
        assert.include(
          output,
          'RETURNED: {"id":"1","status":"running","output":"early\\n"}',
        )
        assert.notInclude(output, "REJECTED:")
        assert.strictEqual(
          yield* waitForLog(environment.cwd, started),
          "start\n",
          "still running after the script ended",
        )
        openGate(environment.cwd)
        assert.strictEqual(
          yield* waitForLog(environment.cwd, finished),
          "start\nfinish\n",
        )
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(executorLayer({ commandTimeout: "300 millis" })),
      ),
    )

    // A foreground command that succeeds returns a task with an id from the
    // same counter as background jobs; one that fails still rejects.
    it.live(
      "returns a task from a foreground bash command, or rejects on failure",
      () =>
        Effect.gen(function* () {
          const output = yield* runScript(`
try {
  console.log("OK:", JSON.stringify(await bash({ command: "echo hi" })))
  console.log("RETURNED:", JSON.stringify(await bash({ command: "echo out && exit 3" })))
} catch (error) {
  console.log("REJECTED:", String(error))
}`)
          assert.include(
            output,
            'OK: {"id":"1","status":"completed","exitCode":0,"output":"hi\\n"}',
          )
          assert.match(
            output,
            /REJECTED:.*Command failed with exit code 3: out/,
          )
          assert.notInclude(output, "RETURNED:")
        }).pipe(Effect.timeout("5 seconds"), Effect.provide(executorLayer({}))),
    )

    it.live("waits for a background task with waitJob", () =>
      Effect.gen(function* () {
        const executor = yield* AgentExecutor.AgentExecutor
        const { environment } = yield* executor.capabilities
        const output = yield* runScript(`
const task = await bash({
  command: ${JSON.stringify(`${gatedCommand(environment.cwd)} && echo done`)},
  background: true,
})
await writeFile({ path: "gate", content: "" })
console.log("WAITED:", JSON.stringify(await waitJob({ id: task.id })))`)
        assert.include(
          output,
          'WAITED: {"id":"1","status":"completed","exitCode":0,"output":"done\\n"}',
        )
      }).pipe(Effect.timeout("5 seconds"), Effect.provide(executorLayer({}))),
    )

    // Without `timeoutMs` the wait uses the caller's command timeout, which
    // also caps it. The test timeout catches a wait that never ends.
    it.live("stops waiting at the timeout and leaves the task running", () =>
      Effect.gen(function* () {
        const executor = yield* AgentExecutor.AgentExecutor
        const { environment } = yield* executor.capabilities
        const output = yield* runScript(`
const task = await bash({
  command: ${JSON.stringify(gatedCommand(environment.cwd))},
  background: true,
})
const waits = [
  await waitJob({ id: task.id, timeoutMs: 100 }),
  await waitJob({ id: task.id }),
  await waitJob({ id: task.id, timeoutMs: 60000 }),
]
console.log("WAITS:", JSON.stringify(waits.map((job) => job.status)))`)
        assert.include(output, 'WAITS: ["running","running","running"]')
        assert.strictEqual(
          yield* waitForLog(environment.cwd, started),
          "start\n",
          "still running after the waits",
        )
        openGate(environment.cwd)
        assert.strictEqual(
          yield* waitForLog(environment.cwd, finished),
          "start\nfinish\n",
        )
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(executorLayer({ commandTimeout: "300 millis" })),
      ),
    )

    it.live("reports background jobs through jobOutput", () =>
      Effect.gen(function* () {
        const executor = yield* AgentExecutor.AgentExecutor
        const { environment } = yield* executor.capabilities
        const output = yield* runScript(`
const done = async (id) => {
  let job = await jobOutput(id)
  while (job.status === "running") {
    await sleep(20)
    job = await jobOutput(id)
  }
  return job
}
await bash({ command: ${JSON.stringify(gatedCommand(environment.cwd))}, background: true })
await bash({ command: "echo out && exit 3", background: true })
console.log("RUNNING:", JSON.stringify(await jobOutput("1")))
await writeFile({ path: "gate", content: "" })
console.log("COMPLETED:", JSON.stringify(await done("1")))
console.log("FAILED:", JSON.stringify(await done("2")))`)
        assert.include(output, 'RUNNING: {"id":"1","status":"running"')
        assert.include(
          output,
          'COMPLETED: {"id":"1","status":"completed","exitCode":0,"output":""}',
        )
        assert.include(
          output,
          'FAILED: {"id":"2","status":"failed","exitCode":3,"output":"out\\n"}',
        )
      }).pipe(Effect.timeout("5 seconds"), Effect.provide(executorLayer({}))),
    )

    it.live("stops a background job with stopJob", () =>
      Effect.gen(function* () {
        const executor = yield* AgentExecutor.AgentExecutor
        const { environment } = yield* executor.capabilities
        const output = yield* runScript(`
await bash({ command: ${JSON.stringify(gatedCommand(environment.cwd))}, background: true })
console.log("STOPPED:", JSON.stringify(await stopJob("1")))
try {
  await stopJob("99")
} catch (error) {
  console.log("REJECTED:", String(error))
}`)
        assert.include(output, 'STOPPED: {"id":"1","status":"stopped"')
        assert.match(output, /REJECTED:.*No background job with id "99"/)
        openGate(environment.cwd)
        yield* Effect.sleep("500 millis")
        assert.notInclude(
          readLog(NodePath.join(environment.cwd, "runs.log")),
          "finish",
          "killed",
        )
      }).pipe(Effect.timeout("5 seconds"), Effect.provide(executorLayer({}))),
    )

    // Interrupting the script ends the call before the command timeout, so
    // the command is stopped rather than handed over.
    it.live(
      "stops a foreground bash command when the script is interrupted",
      () =>
        Effect.gen(function* () {
          const executor = yield* AgentExecutor.AgentExecutor
          const { environment } = yield* executor.capabilities
          const fiber = yield* runScript(
            `await bash({ command: ${JSON.stringify(gatedCommand(environment.cwd))} })`,
          ).pipe(Effect.forkScoped)
          yield* waitForLog(environment.cwd, started)
          yield* Fiber.interrupt(fiber)
          yield* waitForExit(environment.cwd)
          assert.strictEqual(
            readLog(NodePath.join(environment.cwd, "runs.log")),
            "start\n",
            "killed",
          )
        }).pipe(
          Effect.scoped,
          Effect.timeout("5 seconds"),
          Effect.provide(executorLayer({})),
        ),
    )

    // The log sits outside the executor's directory, which is removed with
    // the executor.
    it.live("stops background jobs when the executor shuts down", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        yield* runScript(
          `await bash({ command: ${JSON.stringify(gatedCommand(directory))}, background: true })`,
        ).pipe(
          Effect.andThen(waitForLog(directory, started)),
          Effect.provide(executorLayer({})),
        )
        openGate(directory)
        yield* Effect.sleep("500 millis")
        assert.strictEqual(
          readLog(NodePath.join(directory, "runs.log")),
          "start\n",
          "killed",
        )
      }).pipe(
        Effect.scoped,
        Effect.timeout("5 seconds"),
        Effect.provide(NodeServices.layer),
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

    it.effect("ends a script at the caller's script timeout", () =>
      Effect.gen(function* () {
        const executor = yield* AgentExecutor.AgentExecutor
        const { environment } = yield* executor.capabilities
        const started = yield* Deferred.make<void>()
        const script = yield* executor
          .execute({
            environment,
            onEnvironment: () => Effect.void,
            onTaskComplete: () => Effect.void,
            onImage: () => Effect.void,
            subagents: subagentsUnavailable,
            script: `
console.log("before")
await sleep(10000)
console.log("after")`,
          })
          .pipe(
            Stream.tap((output) =>
              output.includes("before")
                ? Deferred.succeed(started, undefined)
                : Effect.void,
            ),
            Stream.mkString,
            Effect.forkScoped,
          )
        // Worker startup uses real time. Advance the whole-script clock only
        // after output is observed, without changing when its deadline starts.
        yield* Deferred.await(started)
        yield* TestClock.adjust("300 millis")
        const output = yield* Fiber.join(script)
        assert.include(output, "before")
        assert.notInclude(output, "after")
        assert.match(output, /timed out/i)
      }).pipe(
        Effect.provide(executorLayer({ scriptTimeout: "300 millis" })),
        Effect.scoped,
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
        const { output: text } = output as { readonly output: string }
        assert.isBelow(text.length, 10_000 + 500)
        assert.isTrue(text.startsWith("1\n2\n3\n"), "start kept")
        assert.isTrue(text.trimEnd().endsWith("999999\n1000000"), "end kept")
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.provide(executorLayer({ commandOutputChars: 10_000 })),
      ),
    )
  })
}

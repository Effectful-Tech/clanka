import { assert, describe, it } from "@effect/vitest"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as HttpServer from "effect/http/HttpServer"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import * as AgentExecutor from "./AgentExecutor.ts"

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
        const firstStarted = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const outputs = yield* Effect.all(
          [
            executor
              .execute({
                script: 'console.log("first:" + await delegate("first"))',
                onTaskComplete: () => Effect.void,
                onImage: () => Effect.void,
                onSubagent: (prompt) =>
                  Effect.gen(function* () {
                    assert.strictEqual(prompt, "first")
                    yield* Deferred.succeed(firstStarted, undefined)
                    yield* Deferred.await(secondStarted)
                    return "first-output"
                  }),
              })
              .pipe(Stream.runCollect),
            executor
              .execute({
                script: 'console.log("second:" + await delegate("second"))',
                onTaskComplete: () => Effect.void,
                onImage: () => Effect.void,
                onSubagent: (prompt) =>
                  Effect.gen(function* () {
                    assert.strictEqual(prompt, "second")
                    yield* Deferred.succeed(secondStarted, undefined)
                    yield* Deferred.await(firstStarted)
                    return "second-output"
                  }),
              })
              .pipe(Stream.runCollect),
          ],
          { concurrency: "unbounded" },
        )
        assert.strictEqual(outputs[0].join(""), "first:first-output\n")
        assert.strictEqual(outputs[1].join(""), "second:second-output\n")
      }),
    ),
  )

  it.live(
    "completes nested delegation while the parent stream is waiting",
    () =>
      withRpc((executor) =>
        Effect.gen(function* () {
          const output = yield* executor
            .execute({
              script: 'console.log("parent:" + await delegate("outer"))',
              onTaskComplete: () => Effect.void,
              onImage: () => Effect.void,
              onSubagent: (prompt) =>
                Effect.gen(function* () {
                  assert.strictEqual(prompt, "outer")
                  const childOutput = yield* executor
                    .execute({
                      script: 'console.log("child:" + await delegate("inner"))',
                      onTaskComplete: () => Effect.void,
                      onImage: () => Effect.void,
                      onSubagent: (innerPrompt) =>
                        Effect.sync(() => {
                          assert.strictEqual(innerPrompt, "inner")
                          return "inner-output"
                        }),
                    })
                    .pipe(Stream.runCollect)
                  assert.strictEqual(
                    childOutput.join(""),
                    "child:inner-output\n",
                  )
                  return childOutput.join("").trim()
                }),
            })
            .pipe(Stream.runCollect)
          assert.strictEqual(output.join(""), "parent:child:inner-output\n")
        }),
      ),
  )
})

import { assert, describe, it } from "@effect/vitest"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Stream from "effect/Stream"
import * as HttpServer from "effect/http/HttpServer"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import * as AgentExecutor from "./AgentExecutor.ts"
import type { ImageAttachment } from "./AgentTools.ts"
import { equalBytes, supportedImages } from "./fixtures/TestImages.ts"

// Real HTTP transport and NDJSON serialization, not RpcTest's no-codec path.
const withRpc = <A, E, R>(
  f: (
    executor: AgentExecutor.AgentExecutor["Service"],
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* fs.makeTempDirectoryScoped()
    for (const [name, data] of fixtures) {
      yield* fs.writeFile(path.join(directory, name), data)
    }
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
      return yield* f(executor)
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

const fixtures = supportedImages.map(
  ({ fileName, data, mediaType }) => [fileName, data, mediaType] as const,
)

describe("RPC image executor", () => {
  it.live(
    "delivers supported images and markers, then completes the RPC stream",
    () =>
      withRpc((executor) =>
        Effect.gen(function* () {
          const images: Array<ImageAttachment> = []
          const output = yield* executor
            .execute({
              script: fixtures
                .map(
                  ([name]) =>
                    "console.log(await readFile({ path: " +
                    JSON.stringify(name) +
                    " }))",
                )
                .join(";"),
              onImage: (image) =>
                Effect.sync(() => {
                  images.push(image)
                }),
              onTaskComplete: () => Effect.void,
              onSubagent: () => Effect.succeed(""),
            })
            .pipe(Stream.runCollect, Effect.timeout("5 seconds"))
          assert.strictEqual(images.length, fixtures.length)
          for (const [index, [name, bytes, mediaType]] of fixtures.entries()) {
            const image = images[index]!
            assert.strictEqual(image.fileName, name)
            assert.strictEqual(image.mediaType, mediaType)
            assert.instanceOf(image.data, Uint8Array)
            assert.isTrue(equalBytes(image.data, bytes))
            assert.include(output.join(""), "Image attached: " + name)
            assert.notInclude(output.join(""), Base64.encode(bytes))
          }
          assert.notInclude(output.join(""), "data:image/")
        }),
      ),
  )
})

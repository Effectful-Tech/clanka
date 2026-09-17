import { assert, describe, it } from "@effect/vitest"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Stream from "effect/Stream"
import * as HttpServer from "effect/unstable/http/HttpServer"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import * as AgentExecutor from "./AgentExecutor.ts"
import type { ImageAttachment } from "./AgentTools.ts"
import {
  equalBytes,
  tinyPng,
  tinyJpeg,
  tinyWebp,
  animatedGif,
} from "./fixtures/TestImages.ts"

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

const fixtures = [
  ["shot.png", tinyPng, "image/png"],
  ["photo.jpeg", tinyJpeg, "image/jpeg"],
  ["animation.gif", animatedGif, "image/gif"],
  ["picture.webp", tinyWebp, "image/webp"],
] as const

describe("RPC image executor", () => {
  it.live(
    "delivers every image byte and marker through the HTTP client/server",
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
            .pipe(
              // Separate byte delivery from stream completion, checked below.
              Stream.takeUntil((text) =>
                text.includes("Image attached: picture.webp"),
              ),
              Stream.runCollect,
              Effect.timeout("5 seconds"),
            )
          assert.strictEqual(images.length, fixtures.length)
          for (const [index, [name, bytes, mediaType]] of fixtures.entries()) {
            const image = images[index]!
            assert.strictEqual(image.fileName, name)
            assert.strictEqual(image.mediaType, mediaType)
            assert.instanceOf(image.data, Uint8Array)
            assert.isTrue(equalBytes(image.data, bytes))
            assert.include(output.join(""), "Image attached: " + name)
            assert.notInclude(output.join(""), Encoding.encodeBase64(bytes))
          }
          assert.notInclude(output.join(""), "data:image/")
        }),
      ),
  )

  it.live(
    "finishes the RPC execute stream after the image script returns",
    () =>
      withRpc((executor) =>
        Effect.gen(function* () {
          const images: Array<ImageAttachment> = []
          const chunks: Array<string> = []
          const exit = yield* executor
            .execute({
              script: 'console.log(await readFile({ path: "shot.png" }))',
              onImage: (image) =>
                Effect.sync(() => {
                  images.push(image)
                }),
              onTaskComplete: () => Effect.void,
              onSubagent: () => Effect.succeed(""),
            })
            .pipe(
              Stream.runForEach((chunk) =>
                Effect.sync(() => {
                  chunks.push(chunk)
                }),
              ),
              Effect.timeout("2 seconds"),
              Effect.exit,
            )
          assert.strictEqual(images.length, 1)
          assert.include(chunks.join(""), "Image attached: shot.png")
          assert.isTrue(
            Exit.isSuccess(exit),
            "RPC execute must end after delivering the image and marker",
          )
        }),
      ),
  )
})

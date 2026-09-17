import { assert, describe, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { TestClock } from "effect/testing"
import * as Encoding from "effect/Encoding"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Model from "effect/unstable/ai/Model"
import type * as Prompt from "effect/unstable/ai/Prompt"
import type * as AiResponse from "effect/unstable/ai/Response"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import * as Acp from "./Acp.ts"
import * as Agent from "./Agent.ts"
import * as AgentExecutor from "./AgentExecutor.ts"
import {
  bytesOf,
  dimensions,
  encodePng,
  equalBytes,
  tinyPng,
} from "./fixtures/TestImages.ts"

type Message = {
  readonly id?: number
  readonly method?: string
  readonly result?: any
  readonly error?: { readonly code: number; readonly message: string }
  readonly params?: any
}

const capabilities = new AgentExecutor.Capabilities({
  toolsDts: "",
  agentsMd: Option.none(),
  supportsSearch: false,
  skills: [],
})

const executor = AgentExecutor.AgentExecutor.of({
  capabilities: Effect.succeed(capabilities),
  execute: () => Stream.make("script output"),
  executeUnsafe: () => Effect.die("executeUnsafe not implemented"),
})

const assistantSays = (
  text: string,
): Stream.Stream<AiResponse.StreamPartEncoded> =>
  Stream.fromIterable([
    { type: "text-start", id: "1" },
    { type: "text-delta", id: "1", delta: text },
    { type: "text-end", id: "1" },
  ])

/**
 * A server whose model records every prompt it is sent. `prompts[i]` is the
 * prompt of the i-th model call.
 */
const makeServer = Effect.fnUntraced(function* () {
  const sent: Array<Message> = []
  const prompts: Array<Prompt.Prompt> = []
  const languageModel = yield* LanguageModel.make({
    generateText: () => Effect.succeed([]),
    streamText: (options) => {
      prompts.push(options.prompt)
      return assistantSays("I see it")
    },
  })
  const modelLayer = Layer.mergeAll(
    Layer.succeed(LanguageModel.LanguageModel, languageModel),
    Layer.succeed(Model.ProviderName, "test"),
    Layer.succeed(Model.ModelName, "model"),
  )
  const server = yield* Acp.make({
    version: "test",
    defaultModel: "test/model",
    send: (message) =>
      Effect.sync(() => {
        sent.push(message as Message)
      }),
    makeAgent: () =>
      Agent.make.pipe(
        Effect.provideService(AgentExecutor.AgentExecutor, executor),
      ),
    makeModel: (modelId) =>
      modelId === "test/model"
        ? Option.some(
            Layer.merge(modelLayer, Agent.layerSubagentModel(modelLayer)),
          )
        : Option.none(),
  })
  const request = (id: number, method: string, params?: unknown) =>
    server
      .handle(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      .pipe(Effect.map(() => sent.find((m) => m.id === id)!))
  const newSession = (cwd: string) =>
    request(1, "session/new", { cwd, mcpServers: [] }).pipe(
      Effect.map((created) => created.result.sessionId as string),
    )
  return { sent, prompts, request, newSession }
})

/** Every `file` part in the last user message of a prompt. */
const lastUserMessage = (prompt: Prompt.Prompt): Prompt.UserMessage => {
  const message = prompt.content.findLast((m) => m.role === "user")
  assert.isDefined(message, "expected a user message")
  return message as Prompt.UserMessage
}

const fileParts = (message: Prompt.UserMessage): Array<Prompt.FilePart> =>
  message.content.filter((part) => part.type === "file")

const textOf = (message: Prompt.UserMessage): string =>
  message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")

/** An HttpClient that serves `bytes` as `image/png` and records the URLs. */
const makeHttp = (bytes: Uint8Array | ((url: URL) => Uint8Array)) => {
  const urls: Array<string> = []
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      urls.push(url.toString())
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          new Uint8Array(typeof bytes === "function" ? bytes(url) : bytes),
          {
            headers: { "content-type": "image/png" },
          },
        ),
      )
    }),
  )
  return { urls, layer: Layer.succeed(HttpClient.HttpClient, client) }
}

const withServices = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  http: Layer.Layer<HttpClient.HttpClient> = makeHttp(tinyPng).layer,
) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        KeyValueStore.layerMemory,
        Agent.ConversationMode.layer(true),
        NodeServices.layer,
        http,
      ),
    ),
    Effect.scoped,
  )

const withTempDir = <A, E, R>(f: (cwd: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const cwd = yield* fs.makeTempDirectoryScoped()
    return yield* f(cwd)
  })

const base64 = (bytes: Uint8Array) => Encoding.encodeBase64(bytes)

describe("Acp images", () => {
  it.effect("maps an image block onto a file part instead of text", () =>
    withServices(
      Effect.gen(function* () {
        const server = yield* makeServer()
        const init = yield* server.request(0, "initialize", {
          protocolVersion: 1,
        })
        assert.deepStrictEqual(
          init.result.agentCapabilities.promptCapabilities,
          { image: true, audio: false, embeddedContext: true },
        )
        const sessionId = yield* server.newSession("/tmp")
        const done = yield* server.request(2, "session/prompt", {
          sessionId,
          prompt: [
            { type: "text", text: "describe this screenshot" },
            { type: "image", data: base64(tinyPng), mimeType: "image/png" },
          ],
        })
        assert.deepStrictEqual(done.result, { stopReason: "end_turn" })
        assert.strictEqual(server.prompts.length, 1)

        const message = lastUserMessage(server.prompts[0]!)
        const images = fileParts(message)
        assert.strictEqual(images.length, 1)
        assert.strictEqual(images[0]!.mediaType, "image/png")
        assert.isTrue(equalBytes(bytesOf(images[0]!.data), tinyPng))

        const text = textOf(message)
        assert.include(text, "describe this screenshot")
        assert.notInclude(text, base64(tinyPng))
        // Text comes first, the image after, matching the block order.
        assert.strictEqual(message.content[0]!.type, "text")
        assert.strictEqual(message.content[1]!.type, "file")
      }),
    ),
  )

  it.effect("keeps image parts in the persisted session across a load", () =>
    withServices(
      Effect.gen(function* () {
        const kvs = yield* KeyValueStore.KeyValueStore
        const store = KeyValueStore.toSchemaStore(
          KeyValueStore.prefix(kvs, "session-"),
          Acp.SessionRecord,
        )

        const first = yield* makeServer()
        const sessionId = yield* first.newSession("/tmp")
        yield* first.request(2, "session/prompt", {
          sessionId,
          prompt: [
            { type: "text", text: "remember this" },
            { type: "image", data: base64(tinyPng), mimeType: "image/png" },
          ],
        })

        const persisted = Option.getOrThrow(yield* store.get(sessionId))
        const persistedImages = persisted.history.content.flatMap((m) =>
          m.role === "user" ? fileParts(m) : [],
        )
        assert.strictEqual(persistedImages.length, 1)
        assert.isTrue(equalBytes(bytesOf(persistedImages[0]!.data), tinyPng))

        const second = yield* makeServer()
        const loaded = yield* second.request(1, "session/load", {
          sessionId,
          cwd: "/tmp",
        })
        assert.isUndefined(loaded.error)
        const replay = second.sent.filter(
          (message) =>
            message.method === "session/update" &&
            message.params.sessionId === sessionId &&
            message.params.update.sessionUpdate === "user_message_chunk",
        )
        assert.deepStrictEqual(
          replay.map((message) => message.params.update.content),
          [
            { type: "text", text: "remember this" },
            { type: "image", data: base64(tinyPng), mimeType: "image/png" },
          ],
        )
        assert.strictEqual(
          second.prompts.length,
          0,
          "load must not call the model",
        )
        yield* second.request(2, "session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "what did I show you?" }],
        })
        assert.strictEqual(second.prompts.length, 1)
        const images = second.prompts[0]!.content.flatMap((m) =>
          m.role === "user" ? fileParts(m) : [],
        )
        assert.strictEqual(images.length, 1)
        assert.isTrue(equalBytes(bytesOf(images[0]!.data), tinyPng))
      }),
    ),
  )

  it.effect("fetches an https resource_link with an image mime type", () => {
    const http = makeHttp((url) =>
      url.pathname.endsWith(".svg")
        ? new TextEncoder().encode("<svg/>")
        : tinyPng,
    )
    return withServices(
      Effect.gen(function* () {
        const server = yield* makeServer()
        const sessionId = yield* server.newSession("/tmp")
        const done = yield* server.request(2, "session/prompt", {
          sessionId,
          prompt: [
            { type: "text", text: "look" },
            {
              type: "resource_link",
              uri: "https://attachments.example/shot.png",
              name: "shot.png",
              mimeType: "image/png",
            },
            {
              type: "resource_link",
              uri: "https://docs.example/diagram.svg",
              name: "diagram.svg",
              mimeType: "image/svg+xml",
            },
          ],
        })
        assert.deepStrictEqual(done.result, { stopReason: "end_turn" })
        assert.include(
          textOf(lastUserMessage(server.prompts[0]!)),
          "https://docs.example/diagram.svg",
        )
        assert.deepStrictEqual(http.urls, [
          "https://attachments.example/shot.png",
        ])
        const images = fileParts(lastUserMessage(server.prompts[0]!))
        assert.strictEqual(images.length, 1)
        assert.strictEqual(images[0]!.mediaType, "image/png")
        assert.isTrue(equalBytes(bytesOf(images[0]!.data), tinyPng))
      }),
      http.layer,
    )
  })

  it.effect(
    "rejects an oversized streamed image before consuming the whole body",
    () => {
      let pulled = 0
      let cancelled = false
      const chunk = new Uint8Array(1024 * 1024)
      chunk.set(tinyPng)
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream<Uint8Array>({
                pull(controller) {
                  if (pulled === 64) controller.close()
                  else {
                    pulled++
                    controller.enqueue(chunk)
                  }
                },
                cancel() {
                  cancelled = true
                },
              }),
              { headers: { "content-type": "image/png" } },
            ),
          ),
        ),
      )
      return withServices(
        Effect.gen(function* () {
          const server = yield* makeServer()
          const sessionId = yield* server.newSession("/tmp")
          const done = yield* server.request(2, "session/prompt", {
            sessionId,
            prompt: [
              {
                type: "resource_link",
                uri: "https://attachments.example/large.png",
                mimeType: "image/png",
              },
            ],
          })
          assert.strictEqual(done.error?.code, -32602)
          assert.strictEqual(server.prompts.length, 0)
          // No Content-Length: the actual stream must be bounded, not just headers.
          assert.isBelow(pulled, 64, "must stop before buffering 64 MiB")
          assert.isTrue(cancelled, "rejection must cancel the remaining body")
        }),
        Layer.succeed(HttpClient.HttpClient, client),
      )
    },
  )

  it.effect("times out a stalled image body without calling the model", () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(tinyPng)
              },
            }),
            { headers: { "content-type": "image/png" } },
          ),
        ),
      ),
    )
    return withServices(
      Effect.gen(function* () {
        const server = yield* makeServer()
        const sessionId = yield* server.newSession("/tmp")
        const fiber = yield* server
          .request(2, "session/prompt", {
            sessionId,
            prompt: [
              {
                type: "resource_link",
                uri: "https://attachments.example/stalled.png",
                mimeType: "image/png",
              },
            ],
          })
          .pipe(Effect.forkChild)
        // A generous upper bound, not a configurable production deadline.
        yield* TestClock.adjust("1 minute")
        assert.isDefined(
          fiber.pollUnsafe(),
          "image ingestion must finish within one minute",
        )
        const done = yield* Fiber.join(fiber)
        assert.strictEqual(done.error?.code, -32602)
        assert.strictEqual(server.prompts.length, 0)
      }),
      Layer.succeed(HttpClient.HttpClient, client),
    )
  })

  it.effect("rejects a file: resource_link outside the cwd", () =>
    withServices(
      withTempDir((base) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const cwd = path.join(base, "project")
          yield* fs.makeDirectory(cwd)
          const outside = path.join(base, "secret.png")
          yield* fs.writeFile(outside, tinyPng)

          const server = yield* makeServer()
          const sessionId = yield* server.newSession(cwd)
          const done = yield* server.request(2, "session/prompt", {
            sessionId,
            prompt: [
              {
                type: "resource_link",
                // `..` must not escape the cwd either.
                uri: `file://${path.join(cwd, "..", "secret.png")}`,
                name: "secret.png",
                mimeType: "image/png",
              },
            ],
          })
          assert.isDefined(done.error, "prompt must be rejected")
          assert.strictEqual(done.error!.code, -32602)
          assert.strictEqual(server.prompts.length, 0, "no model call")
        }),
      ),
    ),
  )

  it.effect("maps an embedded resource blob with an image mime type", () =>
    withServices(
      Effect.gen(function* () {
        const server = yield* makeServer()
        const sessionId = yield* server.newSession("/tmp")
        const done = yield* server.request(2, "session/prompt", {
          sessionId,
          prompt: [
            {
              type: "resource",
              resource: {
                uri: "file:///attached/shot.png",
                mimeType: "image/png",
                blob: base64(tinyPng),
              },
            },
            {
              type: "resource",
              resource: {
                uri: "file:///attached/diagram.svg",
                mimeType: "image/svg+xml",
                blob: base64(new TextEncoder().encode("<svg/>")),
              },
            },
          ],
        })
        assert.deepStrictEqual(done.result, { stopReason: "end_turn" })
        const message = lastUserMessage(server.prompts[0]!)
        assert.include(textOf(message), "file:///attached/diagram.svg")
        const images = fileParts(message)
        assert.strictEqual(images.length, 1)
        assert.isTrue(equalBytes(bytesOf(images[0]!.data), tinyPng))
        assert.notInclude(textOf(message), base64(tinyPng))
      }),
    ),
  )

  it.effect("applies the image limits to ACP images", () =>
    withServices(
      Effect.gen(function* () {
        const wide = encodePng({ width: 2500, height: 100 })
        const server = yield* makeServer()
        const sessionId = yield* server.newSession("/tmp")
        const done = yield* server.request(2, "session/prompt", {
          sessionId,
          prompt: [
            { type: "image", data: base64(wide), mimeType: "image/png" },
          ],
        })
        assert.deepStrictEqual(done.result, { stopReason: "end_turn" })
        const images = fileParts(lastUserMessage(server.prompts[0]!))
        assert.strictEqual(images.length, 1)
        const size = dimensions(bytesOf(images[0]!.data))
        assert.isAtMost(size.width, 2000)
        assert.isAtMost(size.height, 2000)
      }),
    ),
  )

  it.effect("fetches the uri when an image block has empty data", () => {
    const http = makeHttp(tinyPng)
    return withServices(
      Effect.gen(function* () {
        const server = yield* makeServer()
        const sessionId = yield* server.newSession("/tmp")
        const uri = "https://attachments.example/shot.png"
        const done = yield* server.request(2, "session/prompt", {
          sessionId,
          prompt: [{ type: "image", data: "", uri, mimeType: "image/png" }],
        })
        assert.deepStrictEqual(done.result, { stopReason: "end_turn" })
        assert.deepStrictEqual(http.urls, [uri])
        const images = fileParts(lastUserMessage(server.prompts[0]!))
        assert.strictEqual(images.length, 1)
        assert.strictEqual(images[0]!.mediaType, "image/png")
        assert.isTrue(equalBytes(bytesOf(images[0]!.data), tinyPng))
      }),
      http.layer,
    )
  })

  for (const outside of [false, true]) {
    it.effect(
      outside
        ? "rejects a symlink to an image outside the cwd"
        : "accepts an image symlink inside a symlinked cwd",
      () =>
        withServices(
          withTempDir((base) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem
              const path = yield* Path.Path
              const realCwd = path.join(base, "project")
              const cwd = path.join(base, "project-link")
              yield* fs.makeDirectory(realCwd)
              yield* fs.symlink(realCwd, cwd)
              const target = path.join(outside ? base : realCwd, "target.png")
              yield* fs.writeFile(target, tinyPng)
              const link = path.join(cwd, "shot.png")
              yield* fs.symlink(target, link)

              const server = yield* makeServer()
              const sessionId = yield* server.newSession(cwd)
              const done = yield* server.request(2, "session/prompt", {
                sessionId,
                prompt: [
                  {
                    type: "resource_link",
                    uri: "file://" + link,
                    name: "shot.png",
                    mimeType: "image/png",
                  },
                ],
              })
              if (outside) {
                assert.isDefined(done.error, "prompt must be rejected")
                assert.strictEqual(done.error!.code, -32602)
                assert.include(
                  done.error!.message,
                  "outside the session directory",
                )
                assert.strictEqual(server.prompts.length, 0, "no model call")
              } else {
                assert.deepStrictEqual(done.result, { stopReason: "end_turn" })
                const images = fileParts(lastUserMessage(server.prompts[0]!))
                assert.strictEqual(images.length, 1)
                assert.strictEqual(images[0]!.mediaType, "image/png")
                assert.isTrue(equalBytes(bytesOf(images[0]!.data), tinyPng))
              }
            }),
          ),
        ),
    )
  }

  for (const [uri, missing] of [
    ["https://attachments.example/shot.png", "HttpClient"],
    ["file:///tmp/shot.png", "FileSystem"],
  ] as const) {
    it.effect("rejects an image URI without a " + missing + " service", () =>
      Effect.gen(function* () {
        const server = yield* makeServer()
        const sessionId = yield* server.newSession("/tmp")
        const done = yield* server.request(2, "session/prompt", {
          sessionId,
          prompt: [
            {
              type: "resource_link",
              uri,
              name: "shot.png",
              mimeType: "image/png",
            },
          ],
        })
        assert.isDefined(done.error, "prompt must be rejected")
        assert.strictEqual(done.error!.code, -32602)
        assert.include(done.error!.message, "no " + missing + " available")
        assert.strictEqual(server.prompts.length, 0, "no model call")
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            KeyValueStore.layerMemory,
            Agent.ConversationMode.layer(true),
            NodePath.layer,
          ),
        ),
        Effect.scoped,
      ),
    )
  }
})

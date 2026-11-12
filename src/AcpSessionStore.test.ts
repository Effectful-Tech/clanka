import { assert, describe, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Prompt from "effect/ai/Prompt"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as AcpSessionStore from "./AcpSessionStore.ts"

const message = (role: "user" | "assistant", text: string) =>
  Prompt.makeMessage(role, {
    content: [Prompt.makePart("text", { text })],
  })

const record = (
  messages: ReadonlyArray<Prompt.Message>,
  model = "test:model",
) =>
  new AcpSessionStore.SessionRecord({
    cwd: "/tmp",
    model,
    thoughtLevel: "medium",
    fastMode: false,
    history: Prompt.fromMessages(messages),
  })

const texts = (stored: Option.Option<AcpSessionStore.SessionRecord>) =>
  Option.getOrThrow(stored).history.content.map((message) => {
    const [part] = message.content
    return typeof part === "object" && part.type === "text"
      ? part.text
      : undefined
  })

// Each call is a new process: it knows nothing about the files yet.
const openStore = (directory: string) =>
  Layer.build(AcpSessionStore.layerFileSystem(directory)).pipe(
    Effect.map((context) =>
      Context.get(context, AcpSessionStore.AcpSessionStore),
    ),
  )

const withDirectory = <A, E, R>(
  f: (
    directory: string,
    file: (sessionId: string) => string,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* fs.makeTempDirectoryScoped()
    return yield* f(directory, (sessionId) =>
      path.join(directory, `${sessionId}.jsonl`),
    )
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(NodeServices.layer, KeyValueStore.layerMemory)),
  )

const lines = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(file)
  return text.split("\n").filter((line) => line !== "")
})

describe("AcpSessionStore.layerFileSystem", () => {
  it.effect(
    "appends what each write adds and rewrites a replaced history",
    () =>
      withDirectory(
        Effect.fnUntraced(function* (directory, file) {
          const hello = message("user", "hello")
          const hi = message("assistant", "hi")
          const store = yield* openStore(directory)
          yield* store.set("s", record([hello]))
          yield* store.set("s", record([hello, hi], "other:model"))
          const [first, second] = yield* lines(file("s"))
          assert.include(first, '"Snapshot"')
          assert.include(second, '"Update"')
          assert.notInclude(second, "hello")

          const loaded = yield* (yield* openStore(directory)).get("s")
          assert.deepStrictEqual(texts(loaded), ["hello", "hi"])
          assert.strictEqual(Option.getOrThrow(loaded).model, "other:model")

          yield* store.set("s", record([message("user", "summary")]))
          assert.strictEqual((yield* lines(file("s"))).length, 1)
          const compacted = yield* (yield* openStore(directory)).get("s")
          assert.deepStrictEqual(texts(compacted), ["summary"])
        }),
      ),
  )

  it.effect(
    "drops an interrupted append and replaces the file on the next write",
    () =>
      withDirectory(
        Effect.fnUntraced(function* (directory, file) {
          const fs = yield* FileSystem.FileSystem
          const hello = message("user", "hello")
          const store = yield* openStore(directory)
          yield* store.set("s", record([hello]))
          yield* store.set("s", record([hello, message("assistant", "lost")]))
          // A kill in the middle of the second line.
          const text = yield* fs.readFileString(file("s"))
          yield* fs.writeFileString(
            file("s"),
            text.slice(0, text.indexOf("\n") + 20),
          )

          const next = yield* openStore(directory)
          const loaded = yield* next.get("s")
          assert.deepStrictEqual(texts(loaded), ["hello"])
          const history = Option.getOrThrow(loaded).history.content
          yield* next.set("s", record([...history, message("user", "again")]))

          const reloaded = yield* (yield* openStore(directory)).get("s")
          assert.deepStrictEqual(texts(reloaded), ["hello", "again"])
        }),
      ),
  )

  it.effect(
    "loads a session the KeyValueStore holds and moves it to a file",
    () =>
      withDirectory(
        Effect.fnUntraced(function* (directory, file) {
          const fs = yield* FileSystem.FileSystem
          const legacy = yield* Layer.build(
            AcpSessionStore.layerKeyValueStore,
          ).pipe(
            Effect.map((context) =>
              Context.get(context, AcpSessionStore.AcpSessionStore),
            ),
          )
          yield* legacy.set("s", record([message("user", "hello")]))

          const store = yield* openStore(directory)
          const loaded = yield* store.get("s")
          assert.deepStrictEqual(texts(loaded), ["hello"])
          const history = Option.getOrThrow(loaded).history.content
          yield* store.set(
            "s",
            record([...history, message("assistant", "hi")]),
          )

          assert.isTrue(yield* fs.exists(file("s")))
          const reloaded = yield* (yield* openStore(directory)).get("s")
          assert.deepStrictEqual(texts(reloaded), ["hello", "hi"])
        }),
      ),
  )
})

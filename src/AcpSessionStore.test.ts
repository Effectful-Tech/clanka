import { assert, describe, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Prompt from "effect/ai/Prompt"
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
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

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
    "starts over from a file replaced by another process, even at the same size",
    () =>
      withDirectory(
        Effect.fnUntraced(function* (directory) {
          const a = yield* openStore(directory)
          yield* a.set("s", record([message("user", "old")]))
          const b = yield* openStore(directory)
          const stale = Option.getOrThrow(yield* b.get("s")).history.content
          yield* a.set("s", record([message("user", "new")]))
          yield* b.set("s", record([...stale, message("user", "tail")]))

          const loaded = yield* (yield* openStore(directory)).get("s")
          assert.deepStrictEqual(texts(loaded), ["old", "tail"])
        }),
      ),
  )

  it.effect("never combines the appends of two racing processes", () =>
    withDirectory(
      Effect.fnUntraced(function* (directory) {
        const fs = yield* FileSystem.FileSystem
        // Holds every append until both processes are about to append, so
        // both have checked the file before either writes.
        const bothChecked = yield* Deferred.make<void>()
        let appends = 0
        const racing = FileSystem.FileSystem.of({
          ...fs,
          open: (file, options) =>
            Effect.map(
              fs.open(file, options),
              (handle) =>
                new Proxy(handle, {
                  get: (target, key) =>
                    key === "writeAll"
                      ? (bytes: Uint8Array) =>
                          Effect.gen(function* () {
                            if (++appends === 2) {
                              yield* Deferred.succeed(bothChecked, undefined)
                            }
                            yield* Deferred.await(bothChecked)
                            return yield* target.writeAll(bytes)
                          })
                      : Reflect.get(target, key, target),
                }),
            ),
        })
        const base = [message("user", "base")]
        yield* (yield* openStore(directory)).set("s", record(base))
        const a = yield* openStore(directory).pipe(
          Effect.provideService(FileSystem.FileSystem, racing),
        )
        const b = yield* openStore(directory).pipe(
          Effect.provideService(FileSystem.FileSystem, racing),
        )
        const fromA = Option.getOrThrow(yield* a.get("s")).history.content
        const fromB = Option.getOrThrow(yield* b.get("s")).history.content
        yield* Effect.all(
          [
            a.set("s", record([...fromA, message("user", "A")])),
            b.set("s", record([...fromB, message("user", "B")])),
          ],
          { concurrency: 2 },
        )
        assert.strictEqual(appends, 2)

        const loaded = texts(yield* (yield* openStore(directory)).get("s"))
        assert.oneOf(loaded.join(), ["base,A", "base,B"])
        // Each process sees the file changed, so its next write is whole.
        yield* b.set(
          "s",
          record([...fromB, message("user", "B"), message("user", "C")]),
        )
        const next = yield* (yield* openStore(directory)).get("s")
        assert.deepStrictEqual(texts(next), ["base", "B", "C"])
      }),
    ),
  )
})

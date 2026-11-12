/** @effect-diagnostics schemaNumber:off */
/**
 * Storage for ACP sessions, so `session/load` works across processes.
 *
 * `layerFileSystem` keeps each session in an append-only file. A write adds
 * one line holding what changed since the last write, and rewrites the file
 * only when the history was replaced, for example by compaction.
 *
 * @since 1.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as Prompt from "effect/ai/Prompt"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as AgentExecutor from "./AgentExecutor.ts"

/**
 * Reasoning effort levels offered through the ACP `thought_level` config
 * option.
 *
 * @since 1.0.0
 * @category Models
 */
export const ThoughtLevel = Schema.Literals([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

/**
 * @since 1.0.0
 * @category Models
 */
export type ThoughtLevel = typeof ThoughtLevel.Type

/**
 * @since 1.0.0
 * @category Models
 */
export class SessionRecord extends Schema.Class<SessionRecord>(
  "clanka/Acp/SessionRecord",
)({
  cwd: Schema.String,
  model: Schema.String,
  thoughtLevel: ThoughtLevel,
  /**
   * The session's fast mode setting. It is kept across model switches and
   * applies while the session model supports fast mode.
   */
  fastMode: Schema.optionalKey(Schema.Boolean),
  history: Prompt.Prompt,
  /**
   * The agent's executor environment, such as its working directory.
   */
  environment: Schema.optionalKey(AgentExecutor.ExecutionEnvironment),
}) {}

/**
 * @since 1.0.0
 * @category Errors
 */
export class AcpSessionStoreError extends Schema.TaggedError<AcpSessionStoreError>()(
  "AcpSessionStoreError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * @since 1.0.0
 * @category Services
 */
export class AcpSessionStore extends Context.Service<
  AcpSessionStore,
  {
    readonly get: (
      sessionId: string,
    ) => Effect.Effect<Option.Option<SessionRecord>, AcpSessionStoreError>
    readonly set: (
      sessionId: string,
      record: SessionRecord,
    ) => Effect.Effect<void, AcpSessionStoreError>
  }
>()("clanka/AcpSessionStore") {}

const keyValueStore = (kvs: KeyValueStore.KeyValueStore) => {
  const store = KeyValueStore.toSchemaStore(
    KeyValueStore.prefix(kvs, "session-"),
    SessionRecord,
  )
  return AcpSessionStore.of({
    get: (sessionId) =>
      store
        .get(sessionId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new AcpSessionStoreError({ message: cause.message, cause }),
          ),
        ),
    set: (sessionId, record) =>
      store
        .set(sessionId, record)
        .pipe(
          Effect.mapError(
            (cause) =>
              new AcpSessionStoreError({ message: cause.message, cause }),
          ),
        ),
  })
}

/**
 * Stores each session as one record under `session-<id>` in the
 * KeyValueStore, rewritten whole on every write.
 *
 * @since 1.0.0
 * @category Layers
 */
export const layerKeyValueStore: Layer.Layer<
  AcpSessionStore,
  never,
  KeyValueStore.KeyValueStore
> = Layer.effect(
  AcpSessionStore,
  Effect.gen(function* () {
    return keyValueStore(yield* KeyValueStore.KeyValueStore)
  }),
)

// One line of a session file. A file starts with a `Snapshot`, and each
// `Update` after it holds what changed since the line its `parent` names.
// Every line has a random `id`, encoded last so the end of a file names the
// line that ends it.
const Snapshot = Schema.TaggedStruct("Snapshot", {
  record: SessionRecord,
  id: Schema.String,
})

const Update = Schema.TaggedStruct("Update", {
  cwd: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  thoughtLevel: Schema.optionalKey(ThoughtLevel),
  fastMode: Schema.optionalKey(Schema.Boolean),
  environment: Schema.optionalKey(AgentExecutor.ExecutionEnvironment),
  /** Messages appended to the history. */
  messages: Schema.optionalKey(Schema.Array(Prompt.Message)),
  parent: Schema.String,
  id: Schema.String,
})

const Entry = Schema.Union([Snapshot, Update])
type Entry = typeof Entry.Type

const EntryJson = Schema.fromJsonString(Schema.toCodecJson(Entry))
const decodeEntry = Schema.decodeExit(EntryJson)
const encodeEntry = Schema.encodeEffect(EntryJson)

const fieldKeys = [
  "cwd",
  "model",
  "thoughtLevel",
  "fastMode",
  "environment",
] as const

const applyUpdate = (
  record: SessionRecord,
  update: typeof Update.Type,
): SessionRecord => {
  const { _tag, messages, parent: _parent, id: _id, ...fields } = update
  return new SessionRecord({
    ...record,
    ...fields,
    history:
      messages === undefined
        ? record.history
        : Prompt.fromMessages([...record.history.content, ...messages]),
  })
}

// What changed from `previous` to `next`, or `undefined` when only a
// snapshot can express it: the history was not appended to, or a field was
// removed.
const diff = (
  previous: SessionRecord,
  next: SessionRecord,
): Omit<typeof Update.Type, "_tag" | "parent" | "id"> | undefined => {
  const before = previous.history.content
  const after = next.history.content
  if (
    after.length < before.length ||
    before.some((message, index) => after[index] !== message)
  ) {
    return undefined
  }
  const changes: Record<string, unknown> = {}
  for (const key of fieldKeys) {
    if (previous[key] === next[key]) continue
    if (next[key] === undefined) return undefined
    changes[key] = next[key]
  }
  if (after.length > before.length) {
    changes.messages = after.slice(before.length)
  }
  return changes
}

const storeError =
  (message: string) =>
  (cause: unknown): AcpSessionStoreError =>
    new AcpSessionStoreError({ message, cause })

const encodeLine = (entry: Entry) =>
  encodeEntry(entry).pipe(
    Effect.map((json) => encoder.encode(`${json}\n`)),
    Effect.mapError(storeError("Failed to encode session")),
  )

const newline = 0x0a
// Enough of the end of a file to hold the `id` of its last line.
const tailLength = 64
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Stores each session in an append-only file, `<directory>/<id>.jsonl`.
 *
 * The first line is a snapshot of the session, and each later line holds the
 * fields and history messages added to the line it names as its parent. A
 * write that cannot be expressed as an addition, such as a compacted history,
 * writes a new file and renames it over the old one.
 *
 * Loading follows the chain of lines from the snapshot and skips any line
 * whose parent is not the line before it in the chain, so it always returns a
 * record exactly as one `set` stored it:
 *
 * - A process killed while appending can leave an incomplete last line, which
 *   loading ignores. The next write replaces the file.
 * - Writes through one layer are serialized. Across layers and processes
 *   there is no lock: one process is expected to own a session at a time, as
 *   when a client kills one process and loads the session in the next. A
 *   write that finds the file changed since this layer last read or wrote it
 *   replaces the file with its record, so concurrent writers to one session
 *   are last-writer-wins, and a write racing another process's write can be
 *   lost. Their histories are never combined.
 *
 * @since 1.0.0
 * @category Layers
 */
export const layerFileSystem = (
  directory: string,
): Layer.Layer<
  AcpSessionStore,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Layer.effect(
    AcpSessionStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.makeDirectory(directory, { recursive: true })
      const semaphore = yield* Semaphore.make(1)

      // What this layer last read or wrote in each file: the record its chain
      // adds up to, the id of the chain's last line, and the file's length and
      // last bytes. A file that is no longer exactly this gets a snapshot.
      const files = new Map<
        string,
        {
          readonly record: SessionRecord
          readonly id: string
          readonly size: number
          readonly tail: Uint8Array
        }
      >()

      const fileFor = (sessionId: string) =>
        path.join(directory, `${encodeURIComponent(sessionId)}.jsonl`)

      const read = Effect.fnUntraced(function* (sessionId: string) {
        const file = fileFor(sessionId)
        files.delete(sessionId)
        const result = yield* fs.readFile(file).pipe(
          Effect.asSome,
          Effect.catchReason(
            "PlatformError",
            "NotFound",
            () => Effect.succeedNone,
          ),
          Effect.mapError(storeError(`Failed to read session ${sessionId}`)),
        )
        if (Option.isNone(result)) return Option.none()
        const bytes = result.value
        let record: SessionRecord | undefined
        let id = ""
        let start = 0
        while (start < bytes.length) {
          const end = bytes.indexOf(newline, start)
          // An incomplete last line: the append writing it was cut short.
          if (end === -1) break
          const entry = decodeEntry(decoder.decode(bytes.subarray(start, end)))
          start = end + 1
          if (entry._tag === "Failure") continue
          const line = entry.value
          if (line._tag === "Snapshot") {
            if (record !== undefined) continue
            record = line.record
          } else {
            // Written by a process that did not know the file ended here.
            if (record === undefined || line.parent !== id) continue
            record = applyUpdate(record, line)
          }
          id = line.id
        }
        if (record === undefined) {
          return yield* new AcpSessionStoreError({
            message: `Session file for ${sessionId} does not start with a snapshot`,
          })
        }
        if (start < bytes.length) {
          yield* Effect.logWarning(
            "Ignoring an incomplete end of an ACP session file",
          ).pipe(Effect.annotateLogs({ sessionId, file }))
        } else {
          files.set(sessionId, {
            record,
            id,
            size: bytes.length,
            tail: bytes.slice(-tailLength),
          })
        }
        return Option.some(record)
      })

      // Writes the whole record to a new file, then renames it over the old
      // one, so a reader sees either file complete.
      const writeSnapshot = Effect.fnUntraced(function* (
        sessionId: string,
        record: SessionRecord,
      ) {
        const file = fileFor(sessionId)
        const temporary = `${file}.${crypto.randomUUID()}.tmp`
        const id = crypto.randomUUID()
        const bytes = yield* encodeLine(Snapshot.make({ record, id }))
        files.delete(sessionId)
        yield* fs.writeFile(temporary, bytes).pipe(
          Effect.andThen(fs.rename(temporary, file)),
          Effect.onError(() =>
            Effect.ignore(fs.remove(temporary, { force: true })),
          ),
          Effect.mapError(storeError(`Failed to write session ${sessionId}`)),
        )
        files.set(sessionId, {
          record,
          id,
          size: bytes.length,
          tail: bytes.slice(-tailLength),
        })
      })

      // Appends `bytes` when the file is still what this layer last left
      // there: the same length, ending in the same line. Another process
      // only ever appends to a file, which changes its length, or replaces
      // it with a snapshot, which ends in a line with a new id.
      const append = Effect.fnUntraced(
        function* (
          sessionId: string,
          known: { readonly size: number; readonly tail: Uint8Array },
          bytes: Uint8Array,
        ) {
          const handle = yield* fs.open(fileFor(sessionId), { flag: "a+" })
          const info = yield* handle.stat
          if (Number(info.size) !== known.size) return false
          const tail = new Uint8Array(known.tail.length)
          const read = yield* handle.read(tail, {
            position: BigInt(known.size - tail.length),
          })
          if (
            read !== tail.length ||
            tail.some((byte, index) => byte !== known.tail[index])
          ) {
            return false
          }
          // Forgotten until the append succeeds, so a failed append, which
          // can leave part of a line, is followed by a snapshot.
          files.delete(sessionId)
          yield* handle.writeAll(bytes)
          return true
        },
        Effect.scoped,
        (effect, sessionId) =>
          Effect.mapError(
            effect,
            storeError(`Failed to write session ${sessionId}`),
          ),
      )

      const write = Effect.fnUntraced(function* (
        sessionId: string,
        record: SessionRecord,
      ) {
        const known = files.get(sessionId)
        const changes = known && diff(known.record, record)
        if (known !== undefined && changes !== undefined) {
          if (Object.keys(changes).length === 0) {
            files.set(sessionId, { ...known, record })
            return
          }
          const id = crypto.randomUUID()
          const bytes = yield* encodeLine(
            Update.make({ ...changes, parent: known.id, id }),
          )
          if (yield* append(sessionId, known, bytes)) {
            files.set(sessionId, {
              record,
              id,
              size: known.size + bytes.length,
              tail: bytes.slice(-tailLength),
            })
            return
          }
        }
        yield* writeSnapshot(sessionId, record)
      })

      return AcpSessionStore.of({
        get: (sessionId) => semaphore.withPermit(read(sessionId)),
        set: (sessionId, record) =>
          semaphore.withPermit(write(sessionId, record)),
      })
    }),
  )

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

const legacyStore = (kvs: KeyValueStore.KeyValueStore) => {
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
    return legacyStore(yield* KeyValueStore.KeyValueStore)
  }),
)

// One line of a session file. A file starts with a `Snapshot`, and each
// `Update` after it holds what changed since the line before.
const Snapshot = Schema.TaggedStruct("Snapshot", { record: SessionRecord })

const Update = Schema.TaggedStruct("Update", {
  cwd: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  thoughtLevel: Schema.optionalKey(ThoughtLevel),
  fastMode: Schema.optionalKey(Schema.Boolean),
  environment: Schema.optionalKey(AgentExecutor.ExecutionEnvironment),
  /** Messages appended to the history. */
  messages: Schema.optionalKey(Schema.Array(Prompt.Message)),
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
  const { _tag, messages, ...fields } = update
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
): Omit<typeof Update.Type, "_tag"> | undefined => {
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
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Stores each session in an append-only file, `<directory>/<id>.jsonl`.
 *
 * The first line is a snapshot of the session, and each later line holds the
 * fields and history messages added since the line before. A write that
 * cannot be expressed as an addition, such as a compacted history, writes a
 * new file and renames it over the old one.
 *
 * A process killed while appending can leave an incomplete last line. Loading
 * ignores it, and the next write replaces the file. So does a write after the
 * file changed in a way this process did not expect, such as another process
 * appending to it.
 *
 * Sessions missing from the directory are read from the KeyValueStore, where
 * `layerKeyValueStore` keeps them, and move to a file on their next write.
 *
 * @since 1.0.0
 * @category Layers
 */
export const layerFileSystem = (
  directory: string,
): Layer.Layer<
  AcpSessionStore,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | KeyValueStore.KeyValueStore
> =>
  Layer.effect(
    AcpSessionStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const legacy = legacyStore(yield* KeyValueStore.KeyValueStore)
      yield* fs.makeDirectory(directory, { recursive: true })
      const semaphore = yield* Semaphore.make(1)

      // What this process knows each file to hold: the record its lines add
      // up to and their length in bytes.
      const files = new Map<
        string,
        { readonly record: SessionRecord; readonly size: number }
      >()

      const fileFor = (sessionId: string) =>
        path.join(directory, `${encodeURIComponent(sessionId)}.jsonl`)

      const read = Effect.fnUntraced(function* (sessionId: string) {
        const file = fileFor(sessionId)
        const bytes = yield* fs.readFile(file).pipe(
          Effect.asSome,
          Effect.catchReason(
            "PlatformError",
            "NotFound",
            () => Effect.succeedNone,
          ),
          Effect.mapError(storeError(`Failed to read session ${sessionId}`)),
        )
        if (Option.isNone(bytes)) {
          files.delete(sessionId)
          return yield* legacy.get(sessionId)
        }
        let record: SessionRecord | undefined
        let size = 0
        while (size < bytes.value.length) {
          const end = bytes.value.indexOf(newline, size)
          // An incomplete last line: the append writing it was cut short.
          if (end === -1) break
          const entry = decodeEntry(
            decoder.decode(bytes.value.subarray(size, end)),
          )
          if (
            entry._tag === "Failure" ||
            (record === undefined && entry.value._tag !== "Snapshot")
          ) {
            break
          }
          record =
            entry.value._tag === "Snapshot"
              ? entry.value.record
              : applyUpdate(record!, entry.value)
          size = end + 1
        }
        if (record === undefined) {
          return yield* new AcpSessionStoreError({
            message: `Session file for ${sessionId} does not start with a snapshot`,
          })
        }
        if (size < bytes.value.length) {
          yield* Effect.logWarning(
            "Ignoring an incomplete end of an ACP session file",
          ).pipe(Effect.annotateLogs({ sessionId, file }))
        }
        files.set(sessionId, { record, size })
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
        const bytes = yield* encodeLine(Snapshot.make({ record }))
        yield* fs.writeFile(temporary, bytes).pipe(
          Effect.andThen(fs.rename(temporary, file)),
          Effect.onError(() =>
            Effect.ignore(fs.remove(temporary, { force: true })),
          ),
          Effect.mapError(storeError(`Failed to write session ${sessionId}`)),
        )
        files.set(sessionId, { record, size: bytes.length })
      })

      // The size of the file, when it is what this process last left there.
      const unchangedSize = (sessionId: string, size: number) =>
        fs.stat(fileFor(sessionId)).pipe(
          Effect.map((info) => Number(info.size) === size),
          Effect.orElseSucceed(() => false),
        )

      const write = Effect.fnUntraced(function* (
        sessionId: string,
        record: SessionRecord,
      ) {
        const known = files.get(sessionId)
        const changes = known && diff(known.record, record)
        if (known !== undefined && changes !== undefined) {
          if (Object.keys(changes).length === 0) {
            files.set(sessionId, { record, size: known.size })
            return
          }
          if (yield* unchangedSize(sessionId, known.size)) {
            const bytes = yield* encodeLine(Update.make(changes))
            // Forgotten until the append succeeds, so a failed append, which
            // can leave part of a line, is followed by a snapshot.
            files.delete(sessionId)
            yield* fs
              .writeFile(fileFor(sessionId), bytes, { flag: "a" })
              .pipe(
                Effect.mapError(
                  storeError(`Failed to write session ${sessionId}`),
                ),
              )
            files.set(sessionId, { record, size: known.size + bytes.length })
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

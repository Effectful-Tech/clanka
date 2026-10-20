/**
 * The MCP server configuration of the `clanka` CLI.
 *
 * Servers come from the user file (`$XDG_CONFIG_HOME/clanka/mcp.json`), the
 * project `.mcp.json` in the cwd and `--mcp-config` files, in increasing
 * precedence. The format is `{ "mcpServers": { "<name>": { ... } } }`, as used
 * by Claude Code and Cursor.
 *
 * @since 1.0.0
 */
import * as Config from "effect/Config"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import type * as McpServers from "./McpServers.ts"

/**
 * An MCP config file that cannot be read or decoded.
 *
 * @since 1.0.0
 * @category Errors
 */
export class McpConfigError extends Schema.TaggedError<McpConfigError>()(
  "McpConfigError",
  { message: Schema.String },
) {}

const ConfigFile = Schema.Struct({
  mcpServers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})

// Unknown keys, such as `disabled` or `alwaysAllow`, are dropped.
const FileEntry = Schema.Struct({
  type: Schema.optionalKey(Schema.Literals(["stdio", "http", "sse"])),
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  cwd: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Milliseconds. */
  connectTimeout: Schema.optionalKey(Schema.Finite),
  /** Milliseconds. */
  callTimeout: Schema.optionalKey(Schema.Finite),
})

/**
 * Reads and merges the config files. A later source replaces a server of the
 * same name whole. `enabled: false` (`--no-mcp`) reads nothing.
 *
 * `${VAR}` and `${VAR:-default}` are expanded in `command`, `args`, `env`,
 * `cwd`, `url` and `headers`; a server referring to a variable that is not
 * set is unavailable. A relative `cwd` resolves against the directory of the
 * file that defines it.
 *
 * @since 1.0.0
 * @category Loading
 */
export const load = Effect.fnUntraced(function* (options: {
  readonly cwd: string
  /** The `--mcp-config` files, in the order given. */
  readonly files: ReadonlyArray<string>
  readonly enabled: boolean
}): Effect.fn.Return<
  Record<string, McpServers.ServerEntry>,
  McpConfigError,
  FileSystem.FileSystem | Path.Path
> {
  if (!options.enabled) return {}
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const configHome = yield* Config.NonEmptyString("XDG_CONFIG_HOME").pipe(
    Config.orElse(() =>
      Config.NonEmptyString("HOME").pipe(
        Config.map((home) => path.join(home, ".config")),
      ),
    ),
    Config.option,
    Effect.orElseSucceed(() => Option.none<string>()),
  )
  const sources = [
    ...Option.match(configHome, {
      onNone: () => [],
      onSome: (home) => [
        { file: path.join(home, "clanka", "mcp.json"), required: false },
      ],
    }),
    { file: path.join(options.cwd, ".mcp.json"), required: false },
    ...options.files.map((file) => ({
      file: path.resolve(options.cwd, file),
      required: true,
    })),
  ]

  const servers: Record<string, McpServers.ServerEntry> = {}
  for (const { file, required } of sources) {
    const fail = (message: string) =>
      new McpConfigError({ message: `${file}: ${message}` })
    const exists = yield* fs
      .exists(file)
      .pipe(Effect.mapError((error) => fail(error.message)))
    if (!exists && !required) continue
    const text = yield* fs
      .readFileString(file)
      .pipe(Effect.mapError((error) => fail(error.message)))
    const json = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (error) =>
        fail(
          `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ),
    })
    const { mcpServers } = yield* Schema.decodeUnknownEffect(ConfigFile)(
      json,
    ).pipe(Effect.mapError((error) => fail(error.message)))
    for (const [name, entry] of Object.entries(mcpServers ?? {})) {
      servers[name] = yield* decodeEntry(entry, {
        directory: path.dirname(file),
        fail: (message) => fail(`MCP server "${name}": ${message}`),
        resolve: path.resolve,
      })
    }
  }
  return servers
})

const decodeEntry = Effect.fnUntraced(function* (
  raw: unknown,
  options: {
    readonly directory: string
    readonly fail: (message: string) => McpConfigError
    readonly resolve: (...segments: ReadonlyArray<string>) => string
  },
): Effect.fn.Return<McpServers.ServerEntry, McpConfigError> {
  const expanded = yield* expandEntry(raw)
  if (expanded._tag === "Missing") {
    return {
      type: "unavailable",
      error: `environment variable ${expanded.name} is not set`,
    }
  }
  const entry = yield* Schema.decodeUnknownEffect(FileEntry)(
    expanded.value,
  ).pipe(Effect.mapError((error) => options.fail(error.message)))
  const type =
    entry.type ??
    (entry.command !== undefined
      ? "stdio"
      : entry.url !== undefined
        ? "http"
        : undefined)
  const timeouts = {
    ...(entry.connectTimeout !== undefined
      ? { connectTimeout: Duration.millis(entry.connectTimeout) }
      : {}),
    ...(entry.callTimeout !== undefined
      ? { callTimeout: Duration.millis(entry.callTimeout) }
      : {}),
  }
  switch (type) {
    case undefined:
      return yield* options.fail("needs a command or a url")
    case "sse":
      return { type: "unavailable", error: "SSE transport is not supported" }
    case "stdio": {
      if (entry.command === undefined) {
        return yield* options.fail("a stdio server needs a command")
      }
      return {
        type: "stdio",
        command: entry.command,
        ...(entry.args !== undefined ? { args: entry.args } : {}),
        ...(entry.env !== undefined ? { env: redactAll(entry.env) } : {}),
        ...(entry.cwd !== undefined
          ? { cwd: options.resolve(options.directory, entry.cwd) }
          : {}),
        ...timeouts,
      }
    }
    case "http": {
      if (entry.url === undefined) {
        return yield* options.fail("an http server needs a url")
      }
      return {
        type: "http",
        url: entry.url,
        ...(entry.headers !== undefined
          ? { headers: redactAll(entry.headers) }
          : {}),
        ...timeouts,
      }
    }
  }
})

const redactAll = (
  record: Readonly<Record<string, string>>,
): Record<string, Redacted.Redacted<string>> =>
  Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, Redacted.make(value)]),
  )

// =============================================================================
// Environment variables
// =============================================================================

type Expanded =
  | { readonly _tag: "Expanded"; readonly value: unknown }
  | { readonly _tag: "Missing"; readonly name: string }

class MissingVariable extends Data.TaggedError("MissingVariable")<{
  readonly variable: string
}> {}

const variablePattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

const lookup = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Effect.orElseSucceed(() => Option.none<string>()),
  )

const expand = Effect.fnUntraced(function* (text: string) {
  let result = ""
  let last = 0
  for (const match of text.matchAll(variablePattern)) {
    const [whole, name, fallback] = match
    const value = Option.filter(yield* lookup(name!), (value) =>
      fallback === undefined ? true : value !== "",
    )
    if (Option.isNone(value) && fallback === undefined) {
      return yield* new MissingVariable({ variable: name! })
    }
    result +=
      text.slice(last, match.index) + Option.getOrElse(value, () => fallback!)
    last = match.index + whole.length
  }
  return result + text.slice(last)
})

const expandStrings = (value: unknown) =>
  Effect.gen(function* () {
    if (typeof value === "string") return yield* expand(value)
    if (Array.isArray(value)) {
      return yield* Effect.forEach(value, (item: unknown) =>
        typeof item === "string" ? expand(item) : Effect.succeed(item),
      )
    }
    if (typeof value === "object" && value !== null) {
      const result: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) {
        result[key] = typeof item === "string" ? yield* expand(item) : item
      }
      return result
    }
    return value
  })

const expandedFields = ["command", "args", "env", "cwd", "url", "headers"]

const expandEntry = (raw: unknown): Effect.Effect<Expanded> =>
  Effect.gen(function* () {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { _tag: "Expanded", value: raw } as const
    }
    const entry: Record<string, unknown> = { ...raw }
    for (const field of expandedFields) {
      if (field in entry) entry[field] = yield* expandStrings(entry[field])
    }
    return { _tag: "Expanded", value: entry } as const
  }).pipe(
    Effect.catch((missing: MissingVariable) =>
      Effect.succeed({ _tag: "Missing", name: missing.variable } as const),
    ),
  )

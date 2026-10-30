import { assert, describe, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { execFile, spawn } from "node:child_process"
import * as Path from "node:path"
import * as Readline from "node:readline"

const cli = Path.join(import.meta.dirname, "cli.ts")

// Runs the CLI with its config and cache files kept out of the user's home.
const cliEnv = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const configHome = yield* fs.makeTempDirectoryScoped()
  return { ...process.env, XDG_CONFIG_HOME: configHome }
})

const run = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const env = yield* cliEnv
    return yield* Effect.promise(
      () =>
        new Promise<string>((resolve, reject) =>
          execFile(
            process.execPath,
            [cli, ...args],
            { env },
            (error, stdout) => (error ? reject(error) : resolve(stdout)),
          ),
        ),
    )
  })

class ClankaExited extends Data.TaggedError("ClankaExited")<{
  readonly message: string
}> {}

// Starts `clanka <args>` as an ACP server, sends it `requests` in order and
// returns its reply to the last one. Fails if clanka exits before replying.
const acp = (
  args: ReadonlyArray<string>,
  requests: ReadonlyArray<{ readonly method: string; readonly params: object }>,
  extraEnv: Record<string, string | undefined> = {},
) =>
  Effect.gen(function* () {
    const env = { ...(yield* cliEnv), ...extraEnv }
    const child = yield* Effect.acquireRelease(
      Effect.sync(() => spawn(process.execPath, [cli, ...args], { env })),
      (child) => Effect.sync(() => child.kill()),
    )
    requests.forEach(({ method, params }, index) =>
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: index + 1, method, params })}\n`,
      ),
    )
    return yield* Effect.tryPromise({
      try: () =>
        new Promise<any>((resolve, reject) => {
          let output = ""
          child.stderr.on("data", (chunk) => {
            output += chunk
          })
          const lines = Readline.createInterface({ input: child.stdout })
          lines.on("line", (line) => {
            if (!line.startsWith("{")) {
              output += `${line}\n`
              return
            }
            const message = JSON.parse(line)
            if (message.id === requests.length) resolve(message)
          })
          child.on("exit", (code) =>
            reject(
              new ClankaExited({
                message: `clanka exited with code ${code}:\n${output}`,
              }),
            ),
          )
        }),
      catch: (error) => error as ClankaExited,
    })
  })

const initialize = { method: "initialize", params: { protocolVersion: 1 } }

// The `thought_level` a new session starts with under `clanka <args>`.
const newSessionThoughtLevel = (
  args: ReadonlyArray<string>,
  reasoning: string | undefined,
  extraEnv: Record<string, string | undefined> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const cwd = yield* fs.makeTempDirectoryScoped()
    const response = yield* acp(
      args,
      [initialize, { method: "session/new", params: { cwd, mcpServers: [] } }],
      { ...extraEnv, CLANKA_REASONING: reasoning },
    )
    return response.result.configOptions.find(
      (option: any) => option.id === "thought_level",
    )?.currentValue
  })

describe("cli", () => {
  it.effect(
    "prints the --reported-version override for --version",
    () =>
      Effect.gen(function* () {
        const stdout = yield* run(["--reported-version", "2.33.0", "--version"])
        assert.include(stdout, "2.33.0")
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  )

  it.effect(
    "runs acp with --trust-all-tools and the --reported-version override",
    () =>
      Effect.gen(function* () {
        const response = yield* acp(
          ["--reported-version", "2.33.0", "acp", "--trust-all-tools"],
          [initialize],
        )
        assert.strictEqual(response.result.agentInfo.version, "2.33.0")
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  )
  it.effect(
    "acp defaults the thought level to medium when --model has no effort",
    () =>
      Effect.gen(function* () {
        const level = yield* newSessionThoughtLevel(
          ["acp", "--model", "openai/gpt-6-astra"],
          undefined,
        )
        assert.strictEqual(level, "medium")
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  )

  it.effect(
    "acp takes the default thought level from CLANKA_REASONING, unless --model has an effort",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* newSessionThoughtLevel(["acp"], "high"),
          "high",
        )
        assert.strictEqual(
          yield* newSessionThoughtLevel(
            ["acp", "--model", "openai/gpt-6-astra/low"],
            "high",
          ),
          "low",
        )
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  )

  it.effect(
    "acp starts a claude session without running Claude Code",
    () =>
      Effect.gen(function* () {
        const level = yield* newSessionThoughtLevel(
          ["acp", "--model", "claude/claude-opus-5-5/high"],
          undefined,
          { CLANKA_CLAUDE_PATH: "/nonexistent/claude" },
        )
        assert.strictEqual(level, "high")
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  )

  it.effect(
    "acp fails to start with an invalid CLANKA_REASONING",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          acp(["acp"], [initialize], { CLANKA_REASONING: "bogus" }),
        )
        assert.include(error.message, "CLANKA_REASONING")
        assert.notInclude(error.message, "exited with code 0")
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  )
})

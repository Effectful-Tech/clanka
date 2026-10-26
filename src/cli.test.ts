import { assert, describe, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
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

// Starts `clanka <args>` as an ACP server and returns its reply to
// `initialize`.
const initialize = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const env = yield* cliEnv
    const child = yield* Effect.acquireRelease(
      Effect.sync(() => spawn(process.execPath, [cli, ...args], { env })),
      (child) => Effect.sync(() => child.kill()),
    )
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1 },
      })}\n`,
    )
    return yield* Effect.promise(
      () =>
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
            if (message.id === 1) resolve(message)
          })
          child.on("exit", (code) =>
            reject(new Error(`clanka exited with code ${code}:\n${output}`)),
          )
        }),
    )
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
        const response = yield* initialize([
          "--reported-version",
          "2.33.0",
          "acp",
          "--trust-all-tools",
        ])
        assert.strictEqual(response.result.agentInfo.version, "2.33.0")
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  )
})

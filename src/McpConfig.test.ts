import { assert, describe, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Redacted from "effect/Redacted"
import * as McpConfig from "./McpConfig.ts"
import * as McpServers from "./McpServers.ts"

// =============================================================================
// The `clanka` CLI's MCP server configuration: the user file, the project
// `.mcp.json` and `--mcp-config` files, merged into the config handed to
// `McpServers.layer`. `enabled: false` is `--no-mcp` / `CLANKA_MCP=false`.
// The environment, `XDG_CONFIG_HOME` included, comes from the ConfigProvider.
// =============================================================================

interface Files {
  readonly user?: unknown
  readonly project?: unknown
  readonly flags?: Readonly<Record<string, unknown>>
}

/**
 * Writes the files into a fresh directory and loads them, with `project/` as
 * the cwd and `home/` as `XDG_CONFIG_HOME`. A string is written as it is,
 * anything else as JSON.
 */
const load = (
  files: Files,
  options: {
    readonly env?: Readonly<Record<string, string>>
    readonly enabled?: boolean
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped()
    const write = Effect.fnUntraced(function* (file: string, content: unknown) {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      yield* fs.writeFileString(
        file,
        typeof content === "string" ? content : JSON.stringify(content),
      )
    })
    const home = path.join(root, "home")
    const cwd = path.join(root, "project")
    yield* fs.makeDirectory(cwd, { recursive: true })
    if (files.user !== undefined) {
      yield* write(path.join(home, "clanka", "mcp.json"), files.user)
    }
    if (files.project !== undefined) {
      yield* write(path.join(cwd, ".mcp.json"), files.project)
    }
    const flagFiles: Array<string> = []
    for (const [name, content] of Object.entries(files.flags ?? {})) {
      const file = path.join(root, "flags", name)
      yield* write(file, content)
      flagFiles.push(file)
    }
    const config = yield* McpConfig.load({
      cwd,
      files: flagFiles,
      enabled: options.enabled ?? true,
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({
          env: { XDG_CONFIG_HOME: home, ...options.env },
        }),
      ),
    )
    return { config, root }
  })

const at = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (value, key) => (value as Record<string, unknown> | undefined)?.[key],
      value,
    )

const secret = (value: unknown, path: string): string =>
  Redacted.value(at(value, path) as Redacted.Redacted<string>)

describe("McpConfig", () => {
  it.effect("merges the user, project and flag files by precedence", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const { config, root } = yield* load({
        user: {
          mcpServers: {
            shared: {
              command: "user-cmd",
              args: ["--user"],
              env: { FROM: "user" },
            },
            remote: {
              url: "https://user.example/mcp",
              headers: { Authorization: "Bearer user" },
              disabled: true,
              alwaysAllow: ["anything"],
            },
          },
        },
        project: {
          mcpServers: {
            shared: { command: "project-cmd" },
            tool: { command: "project-tool" },
          },
        },
        flags: {
          "a.json": { mcpServers: { tool: { command: "a-tool" } } },
          "nested/b.json": {
            mcpServers: {
              tool: { command: "b-tool", cwd: "work", callTimeout: 1500 },
            },
          },
        },
      })
      assert.sameMembers(Object.keys(config), ["shared", "remote", "tool"])

      // A higher-precedence entry replaces a lower one whole.
      assert.nestedPropertyVal(config, "shared.type", "stdio")
      assert.nestedPropertyVal(config, "shared.command", "project-cmd")
      assert.notDeepNestedPropertyVal(config, "shared.args", ["--user"])
      assert.notNestedProperty(config, "shared.env.FROM")

      // `type` follows from `url`; unknown keys are ignored.
      assert.nestedPropertyVal(config, "remote.type", "http")
      assert.nestedPropertyVal(config, "remote.url", "https://user.example/mcp")
      assert.strictEqual(
        secret(config, "remote.headers.Authorization"),
        "Bearer user",
      )

      // A later flag wins; its relative `cwd` resolves against its own file.
      assert.nestedPropertyVal(config, "tool.command", "b-tool")
      assert.nestedPropertyVal(
        config,
        "tool.cwd",
        path.join(root, "flags", "nested", "work"),
      )
      assert.strictEqual(
        Duration.toMillis(at(config, "tool.callTimeout") as Duration.Duration),
        1500,
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.live("expands environment variables before decoding", () =>
    Effect.gen(function* () {
      const { config } = yield* load(
        {
          project: {
            mcpServers: {
              local: {
                command: "${BIN:-node}",
                args: ["--token=${TOKEN}", "$TOKEN"],
                env: { KEY: "${TOKEN}" },
                cwd: "${WORK}",
              },
              remote: {
                url: "https://${HOST:-example.com}/mcp",
                headers: { Authorization: "Bearer ${TOKEN}" },
              },
              missing: { command: "node", args: ["${NOT_SET}"] },
            },
          },
        },
        { env: { TOKEN: "t0k", WORK: "/work" } },
      )
      assert.nestedPropertyVal(config, "local.command", "node")
      // Bare `$VAR` is left alone.
      assert.deepNestedPropertyVal(config, "local.args", [
        "--token=t0k",
        "$TOKEN",
      ])
      assert.strictEqual(secret(config, "local.env.KEY"), "t0k")
      assert.nestedPropertyVal(config, "local.cwd", "/work")
      assert.nestedPropertyVal(config, "remote.url", "https://example.com/mcp")
      assert.strictEqual(
        secret(config, "remote.headers.Authorization"),
        "Bearer t0k",
      )

      // A missing variable fails only that server.
      const status = yield* Effect.gen(function* () {
        const servers = yield* McpServers.McpServers
        return yield* servers.status
      }).pipe(Effect.provide(McpServers.layer({ missing: config["missing"]! })))
      const missing = status["missing"]
      assert.strictEqual(missing?._tag, "Failed")
      if (missing?._tag === "Failed") {
        assert.include(missing.error, "environment variable NOT_SET is not set")
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("keeps servers named like Object.prototype members", () =>
    Effect.gen(function* () {
      const { config } = yield* load({
        project:
          '{ "mcpServers": { "__proto__": { "command": "proto-cmd" }, "constructor": { "command": "constructor-cmd" } } }',
      })
      assert.sameMembers(Object.keys(config), ["__proto__", "constructor"])
      assert.strictEqual(at(config, "__proto__.command"), "proto-cmd")
      assert.strictEqual(at(config, "constructor.command"), "constructor-cmd")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("an invalid file stops the CLI unless MCP is disabled", () =>
    Effect.gen(function* () {
      const invalidJson = yield* load({ project: "{ not json" }).pipe(
        Effect.flip,
      )
      assert.include(invalidJson.message, ".mcp.json")

      const invalidEntry = yield* load({
        flags: { "bad.json": { mcpServers: { broken: { command: 42 } } } },
      }).pipe(Effect.flip)
      assert.include(invalidEntry.message, "bad.json")
      assert.include(invalidEntry.message, "broken")

      const disabled = yield* load(
        {
          project: "{ not json",
          flags: { "bad.json": { mcpServers: { broken: { command: 42 } } } },
        },
        { enabled: false },
      )
      assert.deepStrictEqual(disabled.config, {})
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

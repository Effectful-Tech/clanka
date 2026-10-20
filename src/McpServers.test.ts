import { assert, describe, it } from "@effect/vitest"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpServer from "effect/http/HttpServer"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import type * as Prompt from "effect/ai/Prompt"
import type * as Response from "effect/ai/Response"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import * as Agent from "./Agent.ts"
import * as AgentExecutor from "./AgentExecutor.ts"
import * as McpServers from "./McpServers.ts"
import {
  type FakeTool,
  listenHttp,
  makeFakeServer,
  text,
} from "./fixtures/McpFakeServer.ts"
import { tinyPng } from "./fixtures/TestImages.ts"

// =============================================================================
// MCP servers as seen by the model.
//
// The library is observed where the model meets it: the system prompt, the
// `mcp.<server>.<tool>` functions and `searchTools` in a script, plus the
// service's per-server status. Servers are fake SDK servers over
// `InMemoryTransport`, handed to `McpServers.layerTransports`; one test each
// runs the stdio fixture and a loopback HTTP server through
// `McpServers.layer`.
//
// The model is scripted: each call answers with one `execute` script, routed
// by role, as in AgentSubagents.test.ts. A sub-agent's first user message
// carries "TASK-CHILD".
// =============================================================================

type Mode = "local" | "rpc"

const modes: ReadonlyArray<Mode> = ["local", "rpc"]

type Role = "root" | "child"

interface Call {
  readonly role: Role
  readonly index: number
  readonly prompt: Prompt.Prompt
}

interface ExecutorOptions {
  readonly tools?: Toolkit.Any | undefined
}

const localExecutor = (options: ExecutorOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      return AgentExecutor.layerLocal({ directory, ...options })
    }),
  ).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  )

const rpcExecutor = (options: ExecutorOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const { protocol, httpEffect } =
        yield* RpcServer.makeProtocolWithHttpEffect()
      yield* Layer.build(
        AgentExecutor.layerRpcServer({ directory, ...options }).pipe(
          Layer.provide(Layer.succeed(RpcServer.Protocol, protocol)),
        ),
      )
      yield* HttpServer.serveEffect(httpEffect)
      return AgentExecutor.layerRpc.pipe(
        Layer.provide(RpcClient.layerProtocolHttp({ url: "" })),
      )
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        RpcSerialization.layerNdjson,
        NodeHttpServer.layerTest,
        NodeServices.layer,
      ),
    ),
  )

const executorLayer = (mode: Mode, options: ExecutorOptions = {}) =>
  mode === "local" ? localExecutor(options) : rpcExecutor(options)

const messageText = (message: Prompt.Message): string =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")

const systemText = (prompt: Prompt.Prompt): string =>
  prompt.content
    .filter((message) => message.role === "system")
    .map(messageText)
    .join("\n")

const firstUserText = (prompt: Prompt.Prompt): string => {
  const message = prompt.content.find((message) => message.role === "user")
  return message ? messageText(message) : ""
}

const lastToolResult = (prompt: Prompt.Prompt): string => {
  const message = prompt.content.findLast((message) => message.role === "tool")
  if (message === undefined) return ""
  return message.content
    .map((part) => (part.type === "tool-result" ? String(part.result) : ""))
    .join("")
}

const hasPngAttachment = (prompt: Prompt.Prompt): boolean =>
  prompt.content.some(
    (message) =>
      message.role === "user" &&
      typeof message.content !== "string" &&
      message.content.some(
        (part) => part.type === "file" && part.mediaType === "image/png",
      ),
  )

const toolCall = (call: Call, script: string): Response.StreamPartEncoded => ({
  type: "tool-call",
  id: `call-${call.role}-${call.index}`,
  name: "execute",
  params: { script },
})

/**
 * Runs the Agent with whatever `McpServers` the surrounding context provides.
 * A string script must end with `taskComplete`; a function answers every
 * model call.
 */
const runAgent = <LoopTools extends Toolkit.Any = never>(options: {
  readonly mode?: Mode | undefined
  readonly agent?: Agent.Options<LoopTools> | undefined
  readonly script: string | ((call: Call) => string)
}) =>
  Effect.gen(function* () {
    const calls: Array<Call> = []
    const counts: Record<Role, number> = { root: 0, child: 0 }
    const languageModel = yield* LanguageModel.make({
      generateText: () => Effect.die("unexpected generateText call"),
      streamText: (providerOptions) => {
        const role: Role = firstUserText(providerOptions.prompt).includes(
          "TASK-CHILD",
        )
          ? "child"
          : "root"
        const call: Call = {
          role,
          index: counts[role]++,
          prompt: providerOptions.prompt,
        }
        calls.push(call)
        if (typeof options.script !== "string") {
          return Stream.make(toolCall(call, options.script(call)))
        }
        return call.index === 0
          ? Stream.make(toolCall(call, options.script))
          : Stream.die(
              `the script did not call taskComplete: ${lastToolResult(call.prompt)}`,
            )
      },
    })
    const modelLayer = Layer.mergeAll(
      Layer.succeed(LanguageModel.LanguageModel, languageModel),
      Layer.succeed(Model.ProviderName, "test-provider"),
      Layer.succeed(Model.ModelName, "test-model"),
    )
    const agent = yield* Agent.makeWith(options.agent ?? {})
    const summary = yield* agent.send({ prompt: "hello" }).pipe(
      Effect.flatMap(Stream.runDrain),
      Effect.as(""),
      Effect.catchTag("AgentFinished", (finished) =>
        Effect.succeed(finished.summary),
      ),
      Effect.provide(modelLayer),
    )
    return { system: systemText(calls[0]!.prompt), summary, calls }
  }).pipe(
    Effect.scoped,
    Effect.provide(executorLayer(options.mode ?? "local")),
    Effect.timeout("4 seconds"),
  )

// Turns a rejection into a value, so one script can report several calls.
const attempt = `const attempt = (call) => call.then((value) => value, (error) => "ERR " + error.message)
`

/**
 * A fake server reached over `InMemoryTransport`. Every connect builds a new
 * server, so `connections` counts the connections the library opened.
 */
const fake = (options: Parameters<typeof makeFakeServer>[0]) => {
  const state = {
    connections: 0,
    transport: (): Transport => {
      state.connections++
      const [client, server] = InMemoryTransport.createLinkedPair()
      void makeFakeServer(options).connect(server)
      return client
    },
  }
  return state
}

// A server that cannot be reached.
const refused = (): Transport => ({
  start: () => Promise.reject(new Error("connection refused: boom")),
  send: () => Promise.resolve(),
  close: () => Promise.resolve(),
})

// A server that never answers `initialize`.
const silent = (): Transport => InMemoryTransport.createLinkedPair()[0]

const named = (...names: ReadonlyArray<string>): Array<FakeTool> =>
  names.map((name) => ({ name, call: () => text(name) }))

const currentStatus = Effect.gen(function* () {
  const servers = yield* McpServers.McpServers
  return yield* servers.status
})

const failure = (
  status: Effect.Success<typeof currentStatus>,
  name: string,
): string => {
  const server = status[name]
  if (server?._tag !== "Failed") {
    return assert.fail(`expected ${name} to have failed`)
  }
  return server.error
}

const count = (text: string, pattern: RegExp): number =>
  (text.match(pattern) ?? []).length

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const exited = (pid: number) =>
  Effect.sync(() => isRunning(pid)).pipe(
    Effect.repeat({
      while: (running) => running,
      schedule: Schedule.spaced("50 millis"),
    }),
    Effect.timeout("3 seconds"),
  )

const fixture = (path: Path.Path) =>
  path.join(import.meta.dirname, "fixtures", "McpStdioServer.ts")

// Builds an Agent, returning "built" or the defect that stopped it.
const build = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.as("built"),
    Effect.scoped,
    Effect.catchDefect((defect) => Effect.succeed(String(defect))),
  )

// --- lifecycle and prompt ----------------------------------------------------

describe("McpServers", () => {
  it.live(
    "a failed server never stops the Agent and is listed in the prompt",
    () => {
      const github = fake({
        instructions: `GITHUB-INSTRUCTIONS ${"x".repeat(3000)} INSTRUCTIONS-TAIL`,
        tools: [
          {
            name: "create_issue",
            description: "PRIVATE-DESCRIPTION",
            call: () => text("created"),
          },
        ],
      })
      return Effect.gen(function* () {
        const { system, summary } = yield* runAgent({
          script:
            "await taskComplete([typeof mcp.github.create_issue, typeof searchTools].join())",
        })
        const status = yield* currentStatus
        assert.strictEqual(summary, "function,function")
        assert.strictEqual(github.connections, 1)
        assert.strictEqual(status["github"]?._tag, "Connected")
        assert.include(failure(status, "broken"), "boom")
        failure(status, "slow")

        // Instructions are capped; failed servers get one line with the reason.
        assert.include(system, "GITHUB-INSTRUCTIONS")
        assert.notInclude(system, "INSTRUCTIONS-TAIL")
        assert.match(system, /broken.*boom/)
        assert.include(system, "slow")
        assert.include(system, "declare function searchTools(")
        // Tool types are only returned by `searchTools`.
        assert.notInclude(system, "PRIVATE-DESCRIPTION")
        assert.notInclude(system, "declare namespace mcp")
      }).pipe(
        Effect.provide(
          McpServers.layerTransports({
            github: { transport: github.transport },
            broken: { transport: refused },
            slow: { transport: silent, connectTimeout: Duration.millis(50) },
          }),
        ),
      )
    },
  )

  it.live("without a connected server nothing MCP is bound or declared", () =>
    Effect.gen(function* () {
      const script =
        "await taskComplete([typeof mcp, typeof searchTools].join())"

      const without = yield* runAgent({ script })
      assert.strictEqual(without.summary, "undefined,undefined")
      assert.notMatch(without.system, /searchTools|MCP|\bmcp\b/)

      const allFailed = yield* runAgent({ script }).pipe(
        Effect.provide(
          McpServers.layerTransports({ broken: { transport: refused } }),
        ),
      )
      assert.strictEqual(allFailed.summary, "undefined,undefined")
      assert.match(allFailed.system, /broken.*boom/)
      assert.notInclude(allFailed.system, "searchTools")
    }),
  )

  it.live("mcp and searchTools are reserved even without servers", () =>
    Effect.gen(function* () {
      const LoopTools = Toolkit.make(
        Tool.make("searchTools", { parameters: Schema.String }),
      )
      const loopSide = yield* build(
        Agent.makeWith({ loopTools: LoopTools }).pipe(
          Effect.provide([
            executorLayer("local"),
            LoopTools.toLayer({ searchTools: () => Effect.void }),
          ]),
        ),
      )
      assert.notStrictEqual(loopSide, "built")
      assert.include(loopSide, "searchTools")

      const ExecutorTools = Toolkit.make(
        Tool.make("mcp", { parameters: Schema.String }),
      )
      const executorSide = yield* build(
        Agent.make.pipe(
          Effect.provide(
            executorLayer("local", { tools: ExecutorTools }).pipe(
              Layer.provide(ExecutorTools.toLayer({ mcp: () => Effect.void })),
            ),
          ),
        ),
      )
      assert.notStrictEqual(executorSide, "built")
      assert.include(executorSide, "mcp")
    }),
  )

  // --- naming ------------------------------------------------------------------

  it.live("server and tool names are cleaned into identifiers", () =>
    Effect.gen(function* () {
      const { summary } = yield* runAgent({
        script: `const s = mcp.brave_search
await taskComplete(JSON.stringify({
  calls: await Promise.all([s.web_search({}), s.delete_({}), s._2fa({}), s.a_b({}), s.__proto__({})]),
  types: await searchTools({ server: "brave_search" }),
  none: await searchTools({ query: "zzz" }),
}))`,
      })
      const { calls, types, none } = JSON.parse(summary)
      // Each call reaches the tool under its original name; of two tools that
      // clean to the same identifier the first is kept.
      assert.deepStrictEqual(calls, [
        "web-search",
        "delete",
        "2fa",
        "a-b",
        "__proto__",
      ])
      assert.include(types, "declare namespace mcp.brave_search {")
      assert.include(types, "function delete_(")
      assert.strictEqual(count(types, /function a_b\(/g), 1)
      assert.notInclude(types, "web-search")
      // The skipped tool still counts.
      assert.strictEqual(
        none,
        'No MCP tools match "zzz". Servers: brave_search (6 tools).',
      )

      // The later server that cleans to a taken identifier fails, naming the
      // server that holds it. Status keeps the original names.
      const status = yield* currentStatus
      assert.strictEqual(status["brave-search"]?._tag, "Connected")
      assert.include(failure(status, "brave_search"), "brave-search")
    }).pipe(
      Effect.provide(
        McpServers.layerTransports({
          "brave-search": {
            transport: fake({
              tools: named(
                "web-search",
                "delete",
                "2fa",
                "a-b",
                "a_b",
                "__proto__",
              ),
            }).transport,
          },
          brave_search: {
            transport: fake({ tools: named("other") }).transport,
          },
        }),
      ),
    ),
  )

  // --- discovery ---------------------------------------------------------------

  it.live("searchTools finds tools by name, description and parameters", () =>
    Effect.gen(function* () {
      const { summary } = yield* runAgent({
        script: `${attempt}
await taskComplete(JSON.stringify({
  ranked: await searchTools({ query: "issue" }),
  camel: await searchTools({ query: "pull" }),
  parameter: await searchTools({ query: "owner" }),
  byDefault: await searchTools({ query: "widget" }),
  capped: await searchTools({ query: "widget", limit: 50 }),
  server: await searchTools({ server: "many", limit: 1 }),
  neither: await attempt(searchTools({})),
  unknown: await attempt(searchTools({ server: "nope" })),
  none: await searchTools({ query: "zebra" }),
}))`,
      })
      const result = JSON.parse(summary)

      // An exact name match ranks first, with its doc comments.
      assert.include(result.ranked, "declare namespace mcp.github {")
      assert.include(result.ranked, "/** Get one issue by number */")
      assert.include(result.ranked, "/** Issue number */")
      assert.isBelow(
        result.ranked.indexOf("function issue("),
        result.ranked.indexOf("function list_issues("),
      )
      assert.notInclude(result.ranked, "get_me")
      assert.notInclude(result.ranked, "mcp.many")
      assert.include(result.camel, "function createPullRequest(")
      assert.include(result.parameter, "function list_issues(")
      assert.notInclude(result.parameter, "function issue(")

      assert.strictEqual(count(result.byDefault, /function widget_/g), 5)
      assert.strictEqual(count(result.capped, /function widget_/g), 20)
      // `server` alone lists every tool on it and ignores `limit`.
      assert.strictEqual(count(result.server, /function widget_/g), 25)

      for (const rejected of [result.neither, result.unknown]) {
        assert.match(rejected, /^ERR /)
        assert.include(rejected, "github")
        assert.include(rejected, "many")
      }
      assert.strictEqual(
        result.none,
        'No MCP tools match "zebra". Servers: github (4 tools), many (25 tools).',
      )
    }).pipe(
      Effect.provide(
        McpServers.layerTransports({
          github: {
            transport: fake({
              tools: [
                {
                  name: "issue",
                  description: "Get one issue by number",
                  inputSchema: {
                    type: "object",
                    properties: {
                      number: { type: "integer", description: "Issue number" },
                    },
                    required: ["number"],
                  },
                },
                {
                  name: "list_issues",
                  description: "List issues in a repository",
                  inputSchema: {
                    type: "object",
                    properties: { repository_owner: { type: "string" } },
                  },
                },
                {
                  name: "createPullRequest",
                  description: "Open a pull request",
                },
                { name: "get_me", description: "Get the authenticated user" },
              ],
            }).transport,
          },
          many: {
            transport: fake({
              tools: Array.from({ length: 25 }, (_, i) => ({
                name: `widget_${i}`,
                description: "Widget tool",
              })),
            }).transport,
          },
        }),
      ),
    ),
  )

  // --- calls -------------------------------------------------------------------

  it.live("calls validate arguments and map results and errors", () =>
    Effect.gen(function* () {
      const { summary } = yield* runAgent({
        script: `${attempt}
await taskComplete(JSON.stringify({
  echo: await mcp.fake.echo({ text: "hi" }),
  excess: await attempt(mcp.fake.echo({ text: "hi", extra: 1 })),
  blocks: await mcp.fake.blocks({}),
  empty: await mcp.fake.empty({}),
  structured: await mcp.fake.structured({}),
  badOutput: await attempt(mcp.fake.bad_output({})),
  fails: await attempt(mcp.fake.fails({})),
  failsSilently: await attempt(mcp.fake.fails_silently({})),
  conditional: await mcp.fake.conditional({ anything: 1 }),
  types: await searchTools({ server: "fake" }),
}))`,
      })
      const result = JSON.parse(summary)

      assert.strictEqual(result.echo, '{"text":"hi"}')
      assert.match(result.excess, /^ERR mcp\.fake\.echo: /)
      assert.include(result.excess, "extra")
      assert.match(
        result.blocks,
        /^first\n\[Image attached: fake\.blocks-\d+\.png\]\n\[Image omitted \(image\/bmp\): [^\]\n]+\]\n\[Audio omitted \(audio\/wav\)\]\n\[Resource file:\/\/\/notes\.txt\]\s+NOTES\n\[Binary resource omitted: file:\/\/\/data\.bin \(application\/octet-stream\)\]\n\[Resource link: design file:\/\/\/design\.md\]$/,
      )
      assert.strictEqual(result.empty, "")
      // With an `outputSchema` the result is `structuredContent`.
      assert.deepStrictEqual(result.structured, { login: "octocat" })
      // `bad_output` is on the first page: every page's output validator is
      // kept.
      assert.match(result.badOutput, /^ERR mcp\.fake\.bad_output: /)
      assert.strictEqual(result.fails, "ERR mcp.fake.fails: rate limited")
      assert.strictEqual(
        result.failsSilently,
        "ERR mcp.fake.fails_silently: tool returned an error with no message",
      )
      // A schema that cannot be imported is not validated.
      assert.strictEqual(result.conditional, '{"anything":1}')

      assert.match(result.types, /function echo\([^]*?\): Promise<string>/)
      assert.match(
        result.types,
        /function structured\([^]*?\): Promise<\{\s*readonly login: string;\s*\}>/,
      )
      assert.include(
        result.types,
        "function conditional(options: Record<string, unknown>)",
      )
      assert.include(result.types, '"then"')
    }).pipe(
      Effect.provide(
        McpServers.layerTransports({
          fake: {
            transport: fake({
              // One tool per page.
              pageSize: 1,
              tools: [
                {
                  name: "bad_output",
                  outputSchema: {
                    type: "object",
                    properties: { login: { type: "string" } },
                    required: ["login"],
                  },
                  call: () => ({
                    content: [],
                    structuredContent: { login: 42 },
                  }),
                },
                {
                  name: "echo",
                  inputSchema: {
                    type: "object",
                    properties: { text: { type: "string" } },
                    required: ["text"],
                    additionalProperties: false,
                  },
                  call: (args) => text(JSON.stringify(args)),
                },
                {
                  name: "blocks",
                  call: () => ({
                    content: [
                      { type: "text", text: "first" },
                      {
                        type: "image",
                        data: Buffer.from(tinyPng).toString("base64"),
                        mimeType: "image/png",
                      },
                      { type: "image", data: "AAAA", mimeType: "image/bmp" },
                      { type: "audio", data: "AAAA", mimeType: "audio/wav" },
                      {
                        type: "resource",
                        resource: {
                          uri: "file:///notes.txt",
                          mimeType: "text/plain",
                          text: "NOTES",
                        },
                      },
                      {
                        type: "resource",
                        resource: {
                          uri: "file:///data.bin",
                          mimeType: "application/octet-stream",
                          blob: "AAAA",
                        },
                      },
                      {
                        type: "resource_link",
                        name: "design",
                        uri: "file:///design.md",
                      },
                    ],
                  }),
                },
                { name: "empty", call: () => ({ content: [] }) },
                {
                  name: "structured",
                  outputSchema: {
                    type: "object",
                    properties: { login: { type: "string" } },
                    required: ["login"],
                  },
                  call: () => ({
                    content: [{ type: "text", text: "ignored" }],
                    structuredContent: { login: "octocat" },
                  }),
                },
                {
                  name: "fails",
                  call: () => ({ ...text("rate limited"), isError: true }),
                },
                {
                  name: "fails_silently",
                  call: () => ({ content: [], isError: true }),
                },
                {
                  name: "conditional",
                  inputSchema: {
                    type: "object",
                    if: { properties: { kind: { const: "a" } } },
                    // oxlint-disable-next-line unicorn/no-thenable
                    then: { required: ["a"] },
                    else: { required: ["b"] },
                  },
                  call: (args) => text(JSON.stringify(args)),
                },
              ],
            }).transport,
          },
        }),
      ),
    ),
  )

  it.live("a dropped server is not reconnected", () => {
    const server = fake({
      tools: [
        { name: "echo", call: () => text("echo") },
        {
          name: "crash",
          call: (_, { close }) => {
            void close()
            return new Promise(() => {})
          },
        },
      ],
    })
    return Effect.gen(function* () {
      const { summary } = yield* runAgent({
        script: `${attempt}
const crashed = await attempt(mcp.fake.crash({}))
await taskComplete(JSON.stringify({ crashed, after: await attempt(mcp.fake.echo({})) }))`,
      })
      const { crashed, after } = JSON.parse(summary)
      assert.match(crashed, /^ERR mcp\.fake\.crash: /)
      assert.match(
        after,
        /^ERR mcp\.fake\.echo: MCP server "fake" is not connected: /,
      )
      assert.strictEqual(server.connections, 1)
    }).pipe(
      Effect.provide(
        McpServers.layerTransports({ fake: { transport: server.transport } }),
      ),
    )
  })

  it.live("a call that times out is cancelled on the server", () => {
    const cancelled = Promise.withResolvers<void>()
    return Effect.gen(function* () {
      const { summary } = yield* runAgent({
        script:
          'await taskComplete(await mcp.fake.wait({}).then(() => "resolved", (error) => error.message))',
      })
      assert.strictEqual(summary, "mcp.fake.wait: timed out after 50ms")
      yield* Effect.promise(() => cancelled.promise).pipe(
        Effect.timeout("2 seconds"),
      )
    }).pipe(
      Effect.provide(
        McpServers.layerTransports({
          fake: {
            callTimeout: Duration.millis(50),
            transport: fake({
              tools: [
                {
                  name: "wait",
                  call: (_, { signal }) => {
                    signal.addEventListener("abort", () => cancelled.resolve())
                    return new Promise(() => {})
                  },
                },
              ],
            }).transport,
          },
        }),
      ),
    )
  })

  // --- the Agent -----------------------------------------------------------------

  for (const mode of modes) {
    it.live(
      `${mode} executor: sub-agents share the connection and images reach the model`,
      () => {
        const server = fake({
          tools: [
            { name: "ping", call: () => text("pong") },
            {
              name: "screenshot",
              call: () => ({
                content: [
                  {
                    type: "image",
                    data: Buffer.from(tinyPng).toString("base64"),
                    mimeType: "image/png",
                  },
                ],
              }),
            },
          ],
        })
        return Effect.gen(function* () {
          const { summary, calls } = yield* runAgent({
            mode,
            script: (call) => {
              if (call.role === "child") {
                return "await taskComplete(await mcp.fake.ping({}))"
              }
              return call.index === 0
                ? `const child = await delegate({ prompt: "TASK-CHILD" })
console.log(JSON.stringify(child))
console.log(await mcp.fake.screenshot({}))`
                : 'await taskComplete("done")'
            },
          })
          assert.strictEqual(summary, "done")
          assert.strictEqual(server.connections, 1)
          const root = calls.filter((call) => call.role === "root")
          assert.strictEqual(root.length, 2)
          const output = lastToolResult(root[1]!.prompt)
          assert.include(output, "pong")
          assert.match(output, /\[Image attached: fake\.screenshot-\d+\.png\]/)
          assert.isTrue(hasPngAttachment(root[1]!.prompt))
        }).pipe(
          Effect.provide(
            McpServers.layerTransports({
              fake: { transport: server.transport },
            }),
          ),
        )
      },
    )
  }

  // --- transports ----------------------------------------------------------------

  it.live(
    "stdio servers get the merged environment, report stderr and end with the scope",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const out = path.join(yield* fs.makeTempDirectoryScoped(), "out.json")
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.env["FIXTURE_PARENT"] = "from-parent"
            process.env["FIXTURE_TOKEN"] = "from-parent"
          }),
          () =>
            Effect.sync(() => {
              delete process.env["FIXTURE_PARENT"]
              delete process.env["FIXTURE_TOKEN"]
            }),
        )

        const status = yield* currentStatus.pipe(
          Effect.provide(
            McpServers.layer({
              fixture: {
                type: "stdio",
                command: process.execPath,
                args: [fixture(path)],
                cwd: "src",
                env: {
                  FIXTURE_OUT: Redacted.make(out),
                  FIXTURE_TOKEN: Redacted.make("from-config"),
                },
              },
              exploding: {
                type: "stdio",
                command: process.execPath,
                args: [fixture(path)],
                env: { FIXTURE_FAIL: Redacted.make("fixture exploded") },
              },
            }),
          ),
        )
        assert.strictEqual(status["fixture"]?._tag, "Connected")
        assert.include(failure(status, "exploding"), "fixture exploded")

        const started = JSON.parse(yield* fs.readFileString(out))
        // A relative `cwd` resolves against the process cwd.
        assert.strictEqual(started.cwd, path.resolve("src"))
        assert.deepStrictEqual(started.env, {
          FIXTURE_PARENT: "from-parent",
          FIXTURE_TOKEN: "from-config",
        })
        // The layer's scope has closed.
        yield* exited(started.pid)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.live("http servers are sent the static headers", () =>
    Effect.gen(function* () {
      const remote = yield* Effect.acquireRelease(
        Effect.promise(() =>
          listenHttp(makeFakeServer({ tools: named("ping") })),
        ),
        (remote) => Effect.promise(remote.close),
      )
      const status = yield* currentStatus.pipe(
        Effect.provide(
          McpServers.layer({
            remote: {
              type: "http",
              url: remote.url,
              headers: { Authorization: Redacted.make("Bearer secret") },
            },
          }),
        ),
      )
      assert.strictEqual(status["remote"]?._tag, "Connected")
      assert.isNotEmpty(remote.authorization)
      for (const header of remote.authorization) {
        assert.strictEqual(header, "Bearer secret")
      }
    }).pipe(Effect.scoped),
  )
})

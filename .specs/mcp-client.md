# MCP client support

## Overview

An `Agent` can be given MCP servers, over stdio or streamable HTTP. Scripts
call their tools as `mcp.<server>.<tool>(…)`, and the model finds their types
with the loop-side `searchTools` function. The `clanka` CLI reads servers from
config files; `clanka acp` takes them from the ACP `mcpServers` parameter.

MCP tools are built on loop-side tools (see [caller-tools.md](./caller-tools.md)).

Out of scope: clanka as an MCP server; MCP resources, prompts, sampling,
elicitation and roots; the legacy SSE transport; the OAuth flow; permission
prompts for tool calls; search over built-in tools; a separate ACP
`tool_call` per MCP call; `tools/list_changed` handling and reconnects.

`src/McpClient.ts` is unrelated and unchanged: it backs `webSearch` through
Exa's hosted MCP endpoint. `webSearch` stays a built-in.

## Library: `McpServers`

```ts
McpServers.layer(config: Record<string, McpServers.ServerEntry>): Layer<McpServers.McpServers>
McpServers.layerTransports(servers: Record<string, McpServers.TransportServer>): Layer<McpServers.McpServers>

type ServerEntry = McpServerConfig | { type: "unavailable"; error: string }

McpServerConfig =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, Redacted<string>>;
      cwd?: string; connectTimeout?: Duration; callTimeout?: Duration }
  | { type: "http"; url: string; headers?: Record<string, Redacted<string>>;
      connectTimeout?: Duration; callTimeout?: Duration }

interface TransportServer {
  transport: () => Transport
  connectTimeout?: Duration.Input
  callTimeout?: Duration.Input
}
```

- `McpServerConfig` is an Effect Schema union tagged by `type`. `env` and
  `headers` decode from plain strings into `Redacted`; `url` stays plain.
- An `unavailable` entry is reported as `Failed` with its error. The CLI uses
  it for a missing environment variable, ACP for `type: "sse"`.
- `layerTransports` takes transports built by the caller, such as an
  `InMemoryTransport` in tests.
- Logs, status and the system prompt carry only the server name and the error
  message, never config values. The library does no `${ENV}` expansion.

### Service

```ts
interface McpServers {
  status: Effect<Record<string, Connected { tools: string[]; instructions: Option<string> } | Failed { error: string }>>
  prompt: string
  dts: string
  handlers: (onImage) => AgentExecutor.LoopToolHandlers
}
```

- Status is keyed by the configured name. `tools` lists every tool the server
  returned, including any skipped for a name collision.
- The Agent reads the service with `Effect.serviceOption`. Without it, the
  Agent behaves exactly as before. `Agent.make` / `makeWith` signatures do not
  change. Several Agents may share one service; sub-agents use their parent's
  connections.
- `handlers(onImage)` returns one handler per tool, keyed `"<server>.<tool>"`,
  plus `searchTools`. The Agent builds them per run with its image sink, and
  merges them with its loop-side tools.

### Lifecycle

- All servers connect concurrently when the layer is built, each within
  `connectTimeout` (default 30 seconds).
- After connecting, `tools/list` is paged until `nextCursor` is absent, then
  `client.cacheToolMetadata(allTools)` is called once: each `listTools` call
  replaces the output validators with those of its own page.
- A server that fails to start, connect or list its tools is `Failed`, logged
  with `Effect.logWarning` and listed in the system prompt. Building the layer
  never fails because of a server.
- Every client is closed, and every child process ends, with the layer's
  scope.
- A call to a server that dropped rejects with
  `mcp.<server>.<tool>: MCP server "<name>" is not connected: <cause>`, and its
  status becomes `Failed`. There is no reconnect.
- No `listChanged` options are passed; `notifications/tools/list_changed` is
  ignored.

### stdio processes

- `cwd` resolves against the process cwd, which is also the default. The
  library never reads the Agent's `CurrentDirectory`.
- The environment is the full `process.env` with the config `env` on top,
  unwrapped only at spawn.
- stderr is piped and read line by line into `Effect.logDebug`, annotated with
  the server name. Until the server is connected, the last 20 lines (at most
  about 2,000 characters) are kept and appended to the `Failed` error. The
  system prompt shows only the short reason.

HTTP servers use `StreamableHTTPClientTransport` with the headers in
`requestInit`.

## Naming in the sandbox

- Tools are called as `mcp.<server>.<tool>(options)`. Handler keys and the RPC
  `loopTools` list stay flat strings, `"<server>.<tool>"`. The executor's
  sandbox binding splits a name containing `.` once and binds it as
  `mcp[server][tool]`. `mcp` and each server object have a null prototype, so
  `__proto__` and `constructor` are safe names.
- Server and tool names are cleaned into identifiers: every character outside
  `[A-Za-z0-9_$]` becomes `_`, a leading digit gets a `_` prefix, and a
  JavaScript reserved word gets a `_` suffix (`brave-search` → `brave_search`,
  `delete` → `delete_`). Calls use the original tool name.
- When two servers clean to the same identifier, the later one in config order
  is `Failed`, naming the server that holds it. When two tools on one server
  do, the first in `tools/list` order is kept and the others are skipped with
  a warning.
- `mcp` and `searchTools` are reserved, even without servers: an executor tool
  or loop-side tool with either name is a defect when the Agent is built.

## Discovery

```ts
searchTools({ query?: string, server?: string }): Promise<string>
```

One function has two modes, so that only one more global name is reserved:

- `searchTools({ server })` lists every tool on that server, with no cap.
- `searchTools({ query })` searches all servers by keyword and returns at most
  10 tools. With `server` as well, it searches only that server.

The d.ts doc comment leads with one example of each mode.

- Keyword scoring over the tool name (split on `_`, `-` and camelCase, original
  and cleaned), the description and the parameter names. An exact name match
  ranks first.
- Neither argument, or an unknown server, rejects with the list of servers.
- No match resolves with
  `No MCP tools match "<query>". Servers: github (26 tools), playwright (25 tools).`
- The result is grouped by server:

  ```ts
  declare namespace mcp.github {
    /** Create a new issue in a GitHub repository */
    function create_issue(options: { ... }): Promise<...>
  }
  ```

`searchTools` and `mcp` are bound and declared only when at least one server
is connected. MCP tool declarations never appear in the system prompt.

The system prompt lists each connected server with its identifier, tool count,
the exact call that lists its tools (for example
`- github (26 tools). List them with searchTools({ server: "github" }).`) and
its instructions (capped at 2,000 characters), and each failed server on one
line with its reason. When a server is connected, one sentence says how to
call MCP tools, and that their types come from listing a server's tools or
searching across all servers by keyword.

## JSON Schema to d.ts

- `inputSchema` and `outputSchema` are imported with
  `JsonSchema.fromSchemaDraft07` or `fromSchemaDraft2020_12` (by `$schema`,
  defaulting to 2020-12) and
  `SchemaRepresentation.fromJsonSchemaDocument(doc, { patterns: "ignore" })`.
- `TypeBuilder` renders them. Property doc comments fall back to the
  `description` annotation of the property's base node. The
  `omitUnknownIndexSignatures` option, used for output types, leaves out the
  `[x: string]: unknown` of open objects.
- When an input schema cannot be imported, the tool's parameter is
  `Record<string, unknown>` with the raw schema in its doc comment, and its
  arguments are not validated. An output schema that cannot be imported
  renders as `unknown`.

## Calls

- Arguments are decoded with `onExcessProperty: "error"` before `callTool`, so
  a misspelled key is rejected instead of dropped. Defaults are left to the
  server.
- Without an `outputSchema`, a call resolves with its content blocks rendered
  and joined with `\n`:
  - text as it is;
  - images (png, jpeg, gif, webp) are prepared with `Image.prepare` and
    attached to the next model message:
    `[Image attached: <server>.<tool>-<n>.<ext>]`; otherwise
    `[Image omitted (<mime>): <reason>]`;
  - `[Audio omitted (<mime>)]`;
  - `[Resource <uri>]` and the text of a text resource;
    `[Binary resource omitted: <uri> (<mime>)]` for a blob;
  - `[Resource link: <name> <uri>]`.
- With an `outputSchema`, a call resolves with `structuredContent`, which the
  SDK validates against the schema.
- Every failure rejects with an `Error` whose message starts with
  `mcp.<server>.<tool>:`. `isError: true` carries the rendered content, or
  `tool returned an error with no message`.
- Each call is limited by `callTimeout` (default `defaultMcpCallTimeout`, 10
  minutes), enforced with `Effect.timeoutOrElse` and passed to the SDK as
  well. The `AbortSignal` of the call is passed to `callTool`, so a timeout,
  script timeout or interrupt sends `notifications/cancelled`. The message is
  `mcp.<server>.<tool>: timed out after <ms>ms`.

## CLI

- Sources, lowest precedence first: `$XDG_CONFIG_HOME/clanka/mcp.json`
  (falling back to `~/.config/clanka/mcp.json`), `.mcp.json` in the cwd, then
  each `--mcp-config <path>` in order. A higher-precedence server replaces a
  lower one of the same name whole.
- `--no-mcp` or `CLANKA_MCP=false` loads nothing.
- Format: `{ "mcpServers": { "<name>": { ... } } }`. `type` is inferred:
  `stdio` with a `command`, `http` with a `url`. `connectTimeout` and
  `callTimeout` are milliseconds. Unknown keys are ignored. `type: "sse"` is
  reported as unsupported.
- Invalid JSON or an invalid entry stops the CLI with an error naming the file
  and the server.
- `${VAR}` and `${VAR:-default}` are expanded in `command`, `args`, `env`,
  `cwd`, `url` and `headers`. Bare `$VAR` is left alone. A missing variable
  without a default makes that server `Failed`.
- A relative `cwd` resolves against the directory of the file that defines it.
- There is no trust prompt: a project's `.mcp.json` commands run at startup.
- Interactive mode prints one line after connecting, such as
  `MCP: github (26 tools), linear failed: <reason>`.

`McpConfig.load({ cwd, files, enabled })` implements this.

## ACP

- `initialize` advertises `mcpCapabilities: { http: true, sse: false }` and
  `sessionCapabilities.close`.
- `mcpServers` is optional on `session/new`, `session/load` and
  `session/resume`. An entry without `type` is stdio, `type: "http"` is http,
  and `type: "sse"` fails with "SSE transport is not supported". `env` and
  `headers` arrays of `{ name, value }` become `Redacted` records. Of two
  servers with the same name the first wins. ACP servers use the default call
  timeout. stdio servers run in the session's `cwd`.
- Each session owns a scope with its Agent and its own `McpServers` layer,
  shared with its sub-agents. Requests that open a session reply once every
  server has connected or failed.
- `mcpServers` are never persisted in `SessionRecord`: load and resume connect
  the servers sent with that request. A session already open in the process
  keeps its connections.
- `session/close` interrupts a running prompt, closes the session's scope,
  which ends its servers and processes, and forgets the session.
- The first `session/prompt` turn after a session is opened sends one
  `agent_thought_chunk` naming each failed server and its error. A failed
  server never fails `session/new`.
- `clanka acp` ignores the CLI config files, `--no-mcp` and `CLANKA_MCP`.

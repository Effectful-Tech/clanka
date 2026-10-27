# clanka

Make the ai do stuff

## OpenAI API access

The OpenAI provider uses Codex subscription authentication by default. To use an
API key instead, set `CLANKA_OPENAI_API_KEY` or pass `--api-key`:

```sh
export CLANKA_OPENAI_API_KEY="your-api-key"
clanka --provider openai --model gpt-6-astra/medium
```

For a custom endpoint, set `CLANKA_OPENAI_API_URL` or pass `--api-url` with the API base
URL (for example, `https://gateway.example.com/v1`). Flags take precedence over
environment variables. API-key mode uses the HTTP Responses API, so custom
endpoints must support `/responses`. Without a key, the Codex authentication
flow and endpoint remain unchanged. These options do not affect Copilot or xAI.

The ACP server accepts the same options:

```sh
clanka acp --model openai/gpt-6-astra/medium --api-url https://gateway.example.com/v1
```

These options configure the chat model, including subagents. Semantic search
continues to use `OPENAI_API_KEY` and the default OpenAI embeddings endpoint.
Setting only `OPENAI_API_KEY` does not enable API-key mode for chat.

## Fast mode

OpenAI fast mode sends requests on the `priority` service tier: faster
responses at a higher cost. Pass `--fast` or set `CLANKA_FAST=true`:

```sh
clanka --provider openai --model gpt-6-astra/medium --fast
```

It applies to the openai provider, with Codex authentication or an API key, and
is ignored for Copilot and xAI. In `clanka acp`, `--fast` sets the default for
new sessions, and ACP clients can switch it per session with the `fast_mode`
config option. The option is offered only while the session model is an
OpenAI model.

Fast mode is best effort. clanka requests the `priority` tier for any OpenAI
model, but not every model, region or project serves it, and OpenAI decides
which tier actually handles a request. Without fast mode clanka sends no
service tier, so the account or project default applies, which may itself be
fast; the ACP option labels this choice "Default".

## MCP servers

clanka can use the tools of MCP servers, over stdio or streamable HTTP. The CLI
reads servers from these files, later ones winning over earlier ones:

1. `$XDG_CONFIG_HOME/clanka/mcp.json` (or `~/.config/clanka/mcp.json`)
2. `.mcp.json` in the current directory
3. each `--mcp-config <path>`, in order

A server defined again in a later file replaces the earlier definition
entirely. The format is the one Claude Code and Cursor use:

```json
{
  "mcpServers": {
    "github": {
      "command": "github-mcp-server",
      "args": ["stdio"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    },
    "linear": {
      "url": "https://mcp.linear.app/mcp",
      "headers": { "Authorization": "Bearer ${LINEAR_API_KEY}" }
    }
  }
}
```

A server with a `command` runs over stdio, one with a `url` over HTTP.
`${VAR}` and `${VAR:-default}` are expanded in `command`, `args`, `env`, `cwd`,
`url` and `headers`. A relative `cwd` is relative to the file. `callTimeout`
sets a per-call timeout in milliseconds (default 10 minutes). Static headers
are the only HTTP authentication; OAuth and the SSE transport are not
supported.

**Starting clanka in a repository runs the commands in its `.mcp.json`.**
There is no confirmation prompt, so check a repository's `.mcp.json` before
running clanka in it. Pass `--no-mcp`, or set `CLANKA_MCP=false`, to load no
servers at all.

The model calls MCP tools from its scripts as `mcp.<server>.<tool>(options)`.
Their type declarations are not in the system prompt: the model lists a
server's tools with `searchTools({ server })`, or searches all servers by
keyword with `searchTools({ query })`, which returns at most 10 tools. A server
that fails to start is reported and skipped.

`clanka acp` ignores these files and connects the servers the ACP client sends
with `session/new`, `session/load` and `session/resume`.

## Running as kiro-cli

Launchers built for kiro-cli, such as Multica's `kiro` provider, can run
clanka in its place. They start `clanka acp --trust-all-tools`, a flag clanka
accepts and ignores, and enable features by kiro-cli version. Pass
`--reported-version` to set the version clanka reports, for `--version` and in
the ACP `initialize` response:

```sh
clanka --reported-version 2.33.0 --version
```

Put the flag in the launcher's fixed arguments, before the subcommand, so both
the version probe and `clanka acp` see it.

Set `CLANKA_REASONING` to choose the reasoning effort new sessions start with,
for launchers that have no effort setting of their own:

```sh
CLANKA_REASONING=high clanka acp
```

It applies when `--model` has no effort, as in `--model openai/gpt-6-astra`.
An effort in `--model`, such as `openai/gpt-6-astra/low`, takes precedence, and
without either the effort is `medium`. The value must be one of `none`,
`minimal`, `low`, `medium`, `high`, `xhigh` or `max`; anything else stops
`clanka acp` at startup. The ACP client can still change the effort of a
session, and loaded sessions keep the effort they were saved with.

`_session/steer`, kiro-cli's extension method, adds a message to the prompt a
session is running. It takes `{ sessionId, message }` and returns
`{ "queued": true }` when the running prompt will read the message, or
`{ "queued": false }` when the session has no prompt running.

Skills are also discovered in `.kiro/skills/<name>/SKILL.md`, in the project
and in the home directory, next to `.agents/skills`.

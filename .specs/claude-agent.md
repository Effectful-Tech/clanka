# Claude Agent provider

## Overview

A `claude` provider runs Claude models through
`@anthropic-ai/claude-agent-sdk` and the user's own installed, unmodified
Claude Code. clanka never reads, stores or sends Claude.ai credentials, and
never prompts for a login: Claude Code uses whatever login it already has.
Claude Code inherits clanka's environment unchanged, so an `ANTHROPIC_API_KEY`
or `CLAUDE_CODE_OAUTH_TOKEN` set there reaches it. clanka
keeps its agent loop, its single `execute` tool, its system prompt, its
history and its compaction. Claude Code only makes the model calls.

Out of scope: Claude Code's own tools, plan mode, memory, skills,
sub-agents, hooks, auto mode and `/usage`; fast mode; cost display; reading
the account's model list from Claude Code.

## Library: `ClaudeAgent`

```ts
ClaudeAgent.model(model: string, options?: {
  effort?: string | null      // a ThoughtLevel; "none" turns thinking off, null sends no effort
  executable?: string         // default: CLANKA_CLAUDE_PATH, then `claude` on the PATH
  cwd?: string                // default: process.cwd()
  supportsImages?: boolean
  query?: typeof Sdk.query    // default: the SDK's, loaded on first use
}): Model.Model<"claude", LanguageModel, never>

ClaudeAgent.queryOptions(options: {
  model: string
  prompt: Prompt.Prompt
  cwd: string
  pathToClaudeCodeExecutable: string
  effort?: string | null
}): Sdk.Options

ClaudeAgent.toUserContent(prompt: Prompt.Prompt): Array<ContentBlock>
ClaudeAgent.toStreamParts(self: Stream<SDKMessage, E, R>):
  Stream<Response.StreamPartEncoded, E | AiError, R>
ClaudeAgent.minimumClaudeCodeVersion: "2.1.248"
```

The SDK is an optional peer dependency, loaded with a dynamic `import()` the
first time a model call runs, and kept out of the CLI bundle. Without it, a
model call fails with an `AiError` saying to install it.

## One step per `streamText`

The Agent calls `streamText` once per model step and runs the `execute`
handler between steps. Steering, compaction, sub-agent results, turn timeouts
and retries all happen there, so Claude Code's own agent loop must not run
past a step. The SDK has no way to stop after a tool call, so the tool is
parked:

- `execute` is served to Claude Code as `mcp__clanka__execute` by an
  in-process MCP server (the low-level `Server` from
  `@modelcontextprotocol/sdk`, with the tool's JSON schema and
  `readOnlyHint: false`).
- Each handler serves the call named by the request's
  `_meta["claudecode/toolUseId"]`, which every supported Claude Code release
  sends (checked back to 2.1.240). An untagged request fails with an error
  instead of being matched to a guessed call. The handler does not run the
  script: it waits for clanka's result.
- The step ends once the API message that called clanka's tool is done
  (`message_stop` after a `tool_use` for `mcp__clanka__*`) and Claude Code has
  parked a tagged MCP request for every one of those calls. Until then the
  step holds back its `tool-call` parts and its `tool-calls` finish: Effect
  runs a call's handler as soon as more parts follow it, so an early call
  could run a script Claude Code never waits for. Then Effect runs the real
  `execute` handlers, and the Agent appends the calls and results to history
  as for any provider.
- An untagged request, a `tool_result` from Claude Code for a call that
  never parked (Claude Code answered it itself), or, once the tool message's
  `message_stop` is read, a request tagged with an id that message never
  called, fails the step with a non-retryable `AiError` before any script
  runs.
- The next `streamText` resolves the parked handlers with those results and
  reads the next step from the same process.
- A step also ends when Claude Code finishes its turn (`result`), with finish
  reason `stop`, or `length` for `max_tokens`.

Calls to tools clanka did not offer are dropped from the response; Claude
Code answers them itself and the step continues.

## Sessions and continuity

A model layer keeps one live `query()` with a streaming-input prompt. The
session records the prompt of its last step and how the step ended. The next
call continues the session when its prompt:

1. starts with exactly the same message objects as that prompt,
2. then has one assistant message with exactly the text the step emitted
   and exactly its tool calls (same ids, names and params, in order; none
   after a `stop`),
3. then tool messages with a result for every call the step made, and no
   others,
4. then only user messages (at least one if the step ended its turn).

Image-only user messages right after the tool results (the `readFile`
images) go back with the last tool result. Other user messages (environment
updates, steering) are queued as one user message with `priority: "next"`,
or start the next turn after a `stop`.

Anything else (compaction rewrote history, ACP `session/load`, images
stripped after a rejection, a different tool list, a retry of an earlier
step) closes the process and starts a new one with the full history. A
`query()` takes no assistant history, so `toUserContent` renders the prompt
as one user message: each message wrapped in a `<role>` tag, tool calls and
results as `<tool-call>` / `<tool-result>` tags, images as base64 image
blocks. Without earlier turns, no tags are added.

A step that does not reach its finish (interrupted by steering or a turn
timeout, or failed) leaves the session in an unknown state, so the process is
closed and the next call starts over. The model layer's scope closes the live
process. Closing a session ends its messages, so a step still reading it
fails with "Claude Code stopped before finishing its reply" instead of
waiting for the turn timeout.

A model instance reads one step at a time. A call made while another step is
still being read fails with a non-retryable `UnknownError` and leaves that
step's session alone, because continuing or replacing the session would cut
off the other reader.

`Agent.send` keeps an unchanged system message as is instead of calling
`Prompt.setSystem` each turn, so condition 1 holds across user turns. ACP
builds the model layer per prompt, so there each prompt starts one process.
The interactive CLI keeps one process for the whole conversation.
Sub-agents get their own model instance, and with it their own process:
`layerSubagentModel` wraps the layer in `Layer.fresh`, so a sub-agent builds
a new instance even when the same layer is the main agent's model (as in
`ModelLayer`). Without it, the memo map hands the sub-agent the main agent's
instance. The sub-agent's scope closes its process when it ends. The
WebSocket models (Codex, xAI) also get one socket per running sub-agent.

## What Claude Code sees

`queryOptions` sets:

- `pathToClaudeCodeExecutable`, `cwd`, `model`, and `effort` from the thought
  level (`minimal` becomes `low`, `none` sets `thinking: { type: "disabled" }`;
  otherwise `thinking: { type: "adaptive", display: "summarized" }` so
  reasoning summaries stream).
- `systemPrompt: { type: "custom", prompt }` with clanka's system message. The
  `claude_code` preset describes Read, Edit, Bash, TodoWrite, slash commands
  and CLAUDE.md, none of which exist here, and would steer the model toward
  tools Claude Code then rejects.
- `tools: []`, `allowedTools: ["mcp__clanka__*"]`, `permissionMode: "dontAsk"`,
  `settingSources: []`, `settings: { disableAllHooks: true }`,
  `strictMcpConfig: true`, `skills: []`, `verbatimPrompts: true`,
  `includePartialMessages: true`, `persistSession: false` (clanka owns
  history, so nothing is written under `~/.claude/projects`).
- `env`: `process.env` unchanged (including any `ANTHROPIC_API_KEY` or
  `CLAUDE_CODE_OAUTH_TOKEN`), then `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`,
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `DISABLE_AUTO_COMPACT=1`,
  `CLAUDE_CODE_ENABLE_AWAY_SUMMARY=0`, `ENABLE_TOOL_SEARCH=false`,
  `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`, `MAX_MCP_OUTPUT_TOKENS=200000`,
  `CLAUDE_AGENT_SDK_CLIENT_APP=clanka/<version>`, with `CLAUDE_CODE_SIMPLE`,
  `CLAUDE_CODE_EFFORT_LEVEL` and `MCP_TOOL_TIMEOUT` removed.

A call without tools (a compaction summary) runs on its own short-lived
process with no MCP server, and closes it when the step ends.

## Errors and usage

- A `result` with `is_error` or an `api_error_status` of 400 or more fails
  the step with an `AiError`: `AuthenticationError` for
  `authentication_failed`, `InvalidRequestError` for `invalid_request` or a
  "prompt is too long" text (so `Compaction.isContextLengthError` matches),
  else `UnknownError`. None is retryable: Claude Code has already retried.
  "Please run /login" becomes "Run `claude auth login`".
- Claude Code reports an API message several times. Usage keeps each count's
  maximum per message id, sums output tokens over the step, and takes the
  context size from the last call's input plus cache reads and writes.
- On start, `initializationResult().claude_code_version` must be at least
  2.1.248, the first release to honour `verbatimPrompts`.

## Catalog and CLI

- `ModelsRepo.Provider` gains `claude`. models.dev's `anthropic` provider maps
  to it, and `fallback` has `claude/claude-opus-5-5`.
- `ModelLayer.make` builds `ClaudeAgent.model` for `claude`, so
  `--provider claude --model claude-opus-5-5/high` and ACP
  `claude:claude-opus-5-5` work. `supportsFastMode` stays OpenAI only.
- Nothing starts Claude Code before the first model call, so `session/new`
  works without it.

## Terms

Anthropic's terms let an end user sign in to the unmodified Claude Code
binary with their own subscription. Third-party products may not offer
claude.ai login or rate limits, or collect, store or intermediate Claude.ai
credentials. clanka does none of that: it runs the user's own Claude Code
with the user's own login, for the user's own individual use. The
documentation names API keys, Bedrock, Vertex and Foundry as the supported
developer setups, and describes a subscription login as the user's own
choice under their consumer terms, not a clanka feature. The provider is
called Claude Agent, not Claude Code.

## Tests

- `ModelsRepo.test.ts`: models.dev `anthropic` models become `claude`
  models.
- `ModelLayer.test.ts`: `makeAcp` builds `claude:` ids.
- `ClaudeAgent.test.ts`: `queryOptions`, `toUserContent`, and a tool step
  through `toStreamParts`; through a fake SDK `query`: tagged calls get
  their own results in one process, untagged calls fail and run no script,
  an edited answer starts a new process, a step cut short closes its
  process, a second step while one is read fails and keeps the first
  session, and a reader of a closed session fails instead of hanging.
- `Agent.test.ts`: a sub-agent runs on its own model instance.

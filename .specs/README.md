# Specifications

## Projects

- [TypeBuilder](./type-builder.md) - Generate TypeScript type expressions from
  Effect Schema definitions. Ports the original `TypeBuilder.ts` to work with
  Effect v4's restructured SchemaAST.
- [OpenAI Codex Auth](./openai-codex-auth.md) - Authenticate with OpenAI's
  Codex API via the headless device auth flow, using `@effect/ai-openai` as
  the provider layer. Includes token storage via `KeyValueStore`, automatic
  refresh, and a fully wired `LanguageModel` layer.
- [Background sub-agents](./background-subagents.md) - Run `delegate`
  sub-agents in the background, address them by ID with `waitAgents`,
  `messageAgent`, `stopAgent` and `listAgents`, and push their results to the
  parent between model turns.
- [Caller-selected tools, instructions, skills and loop-side tools](./caller-tools.md) -
  Let a caller leave out built-in tools, supply the project instructions and
  skills, and register tools whose handlers run next to the `Agent` rather than
  in the executor, in local and RPC mode.
- [MCP client support](./mcp-client.md) - Give an `Agent` MCP servers over
  stdio or streamable HTTP. Scripts call their tools as
  `mcp.<server>.<tool>(…)` and find their types with `searchTools`. The CLI
  reads servers from config files and `clanka acp` from ACP `mcpServers`.
- [Models catalog from models.dev](./models-repo.md) - A `ModelsRepo` service
  that lists the chat models clanka can run. Its models.dev implementation
  fetches `api.json`, keeps the `openai`, `github-copilot`, `xai` and
  `anthropic` text models, caches the result in the `KeyValueStore`, and feeds
  the CLI model prompt and the ACP `availableModels` list.
- [Claude Agent provider](./claude-agent.md) - A `claude` provider that runs
  Claude models through the Claude Agent SDK and the user's installed Claude
  Code. clanka keeps its loop, `execute` tool and history; a parked MCP tool
  bridges each `execute` call back to clanka.

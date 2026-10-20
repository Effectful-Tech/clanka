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

---
"clanka": minor
---

Add MCP client support. An Agent given `McpServers.layer` can call MCP tools over stdio or streamable HTTP from scripts as `mcp.<server>.<tool>(…)` and find their types with `searchTools`. The CLI reads servers from `~/.config/clanka/mcp.json`, `.mcp.json` and `--mcp-config` (disable with `--no-mcp` or `CLANKA_MCP=false`), and `clanka acp` accepts `mcpServers` and `session/close`.

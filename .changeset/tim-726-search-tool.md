---
"clanka": patch
---

Add a new `search` AgentTool that spawns a subagent from a textual search description and returns its findings.

The `search` subagent is explicitly instructed not to call `search` recursively, and to return a concise report with file paths, line numbers, and code snippets.

---
"clanka": minor
---

Remove semantic search and the tree-sitter dependencies.

The CLI no longer accepts `--search` / `-s`, and agents no longer get a `search` script function. The `SemanticSearch` and `CodeChunker` modules are removed, along with `AgentToolsWithSearch` and `Capabilities.supportsSearch`. Use `AgentTools` in place of `AgentToolsWithSearch`. `rg`, `webSearch` and MCP `searchTools` are unchanged.

`sqlite-vec`, `tree-sitter`, `tree-sitter-javascript` and `tree-sitter-typescript` are no longer dependencies, and `@effect/sql-sqlite-node` is no longer a peer dependency. Line breaks in displayed scripts now come from a small built-in scanner instead of tree-sitter.

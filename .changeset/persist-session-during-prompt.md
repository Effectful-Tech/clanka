---
"clanka": minor
---

Store an ACP session as the agent commits history instead of only when the prompt ends, so a process killed mid-prompt keeps the user's message and every completed response.

`clanka acp` now keeps each session in an append-only file under `$XDG_CONFIG_HOME/clanka/sessions`. A commit appends one line with what it added, and the file is rewritten only when compaction replaces the history. A line cut short by a kill is ignored on load. Sessions stored by earlier versions are not loaded.

`Acp.make` and `Acp.runStdio` now require an `AcpSessionStore` instead of a `KeyValueStore`. Provide `AcpSessionStore.layerFileSystem(directory)` for append-only files, or `AcpSessionStore.layerKeyValueStore` to store each session as one record in a `KeyValueStore`.

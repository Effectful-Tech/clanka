---
"clanka": minor
---

Add a `changeDirectory` tool that validates and changes the executor's working directory across tool calls and scripts. Navigation is shared with delegates, while startup configuration and the semantic-search index root stay fixed. Keep semantic-index updates anchored to absolute file paths after navigation.

Expose the live directory through local and RPC executors and include it in every model request, including retries after compaction. Custom executor implementations must provide `currentDirectory: Effect<string>`.

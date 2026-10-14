---
"clanka": minor
---

Bound retries, command time and command output, and emit history events.

- `Agent.MaxRetries` limits how many times in a row a model call is retried, after a retryable error or after reaching `TurnTimeout`. When the limit is reached, the `send` stream fails with the new `RetriesExhausted` error, which carries the retry count and the last error. **The default is 20 retries. Before this, retries never stopped.**
- `AgentExecutor.layerLocal`, `layerRpcServer`, `makeLocal` and `Agent.layerLocal` take a `limits` option:
  - `commandTimeout` is the longest a `bash` command may run, and its default. It defaults to 10 minutes, as before. The `bash` description now states this limit instead of "default: 120000, max 4 minutes".
  - `scriptTimeout` is the longest an `execute` script may run. When it is reached, the script's running tool calls and their processes are stopped, and its output ends with a line saying it timed out. There is no limit by default.
  - `commandOutputChars` caps how much `bash` and `gh` output is held in memory per command. The start and end of the output are kept while it streams, with a marker in place of the middle. There is no limit by default.
- The `send` stream emits `HistoryAppended` with the messages committed to `agent.history` at each step, and `HistoryReplaced` with the new history when compaction rewrites it. Apply them in order to the history `send` started with and you get `agent.history` without its system message. Consumers that switch over every `Output` tag need cases for these two events.

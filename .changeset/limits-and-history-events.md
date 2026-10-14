---
"clanka": minor
---

- Add `Agent.MaxRetries` and typed `RetriesExhausted` failures. Retries now default to 20 instead of unlimited.
- Add executor `limits` for bash/gh command time, whole-script time (including busy JavaScript), and retained command output. Defaults stay unchanged: bash has a 10-minute limit; gh, whole scripts, and retained output are unlimited. The bash description now reflects the configured limit.
- Emit `HistoryAppended` and `HistoryReplaced` from `send` so consumers can rebuild history across compaction. Exhaustive `Output` handlers need cases for both events.

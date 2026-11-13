---
"clanka": patch
---

Prefix task IDs with `bash_` or `subagent_` so their type is visible in tool results and completion notifications. Numeric task IDs are no longer supported: custom executors must allocate sub-agent IDs as `subagent_<n>`, and both sides of an RPC executor must be upgraded together.

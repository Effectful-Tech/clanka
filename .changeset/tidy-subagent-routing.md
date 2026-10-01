---
"clanka": patch
---

Fix RPC subagent ID collisions across concurrent execute streams, including nested delegation, by allocating IDs from a server-wide counter.

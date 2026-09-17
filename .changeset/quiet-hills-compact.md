---
"clanka": minor
---

Add auto-compaction: an always-on 32k character cap on `execute` results and threshold / overflow compaction of the live Prompt (`Compaction` module, `CompactionConfig`, `ExecuteOutputCapped` / `CompactionStarted` / `CompactionEnded` output events). Disable compaction with `--no-compaction` or `CLANKA_COMPACTION=false`; the output cap stays on.

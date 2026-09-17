---
"clanka": minor
---

Add auto-compaction: an always-on 32k character cap on `execute` results and threshold / overflow compaction of the live Prompt (`Compaction` module, `CompactionConfig`, `ExecuteOutputCapped` / `CompactionStarted` / `CompactionEnded` output events). Disable compaction with `--no-compaction` or `CLANKA_COMPACTION=false`; the output cap stays on.

By default, threshold compaction triggers above 220k tokens of reported usage or estimated prompt size, using a 236k context window with a 16k reserve. Exactly 220k tokens does not trigger compaction.

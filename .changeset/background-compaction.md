---
"clanka": patch
---

Run threshold compaction in the background, so a resumed session no longer waits for the summary before its first output. A compaction times out only when the summarizer goes quiet, and one that fails is not retried with the same input until a few model calls later. Without `--summarizer-model`, the summarizer runs on its own copy of the session model, so a summary can finish after the prompt that started it. `clanka acp` reports compaction progress as thought chunks.

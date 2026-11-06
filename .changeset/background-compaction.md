---
"clanka": patch
---

Run threshold compaction in the background, so a resumed session no longer waits for the summary before its first output. A compaction summarizes at most 64k tokens at a time, times out only when the summarizer goes quiet, and is not retried with the same input after it fails. Without `--summarizer-model`, the summarizer runs on its own copy of the session model, so a summary can finish after the prompt that started it. `clanka acp` reports compaction progress as thought chunks.

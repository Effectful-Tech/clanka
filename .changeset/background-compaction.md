---
"clanka": patch
---

Run threshold compaction in the background, so a resumed session no longer waits for the summary before its first output. A compaction summarizes at most 64k tokens at a time, times out only when the summarizer goes quiet, and is not retried with the same input after it fails. `clanka acp` reports compaction progress as thought chunks.

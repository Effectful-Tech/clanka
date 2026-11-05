---
"clanka": minor
---

Tell the model when a background bash job ends. Before its next call the agent gets a `<job id="…" status="…" exitCode="…">` message with the job's output. A job already reported by `stopJob`, or by a `jobOutput` call that returned its final status, is not pushed. A running job does not keep a conversation-mode run alive. Agent output has a new `JobComplete` event, which `clanka acp` reports as a finished tool call.

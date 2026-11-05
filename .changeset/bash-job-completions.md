---
"clanka": minor
---

Tell the model when a background bash job ends. Before its next call the agent gets a `<job id="…" status="…" exitCode="…">` message with the job's output. A job already reported by `stopJob`, or by a `jobOutput` call that returned its final status, is not pushed. A running job does not keep a conversation-mode run alive. Agent output has a new `JobComplete` event, which `clanka acp` reports as a finished tool call. A job that ends between prompts is reported when the next prompt starts.

Executors report support through the new `Capabilities.jobPushes` flag. With an executor or executor server from before job pushes, the flag is `false` and the model is told to poll with `jobOutput` as before. Clients ask for job updates with the optional `watchJobs` key of the `execute` RPC, so older clients never receive parts they cannot decode.

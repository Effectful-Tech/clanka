---
"clanka": minor
---

`bash` now returns a task, `{ id, status, exitCode?, output }`, instead of a string. It's the same shape `jobOutput` and `stopJob` return. A foreground command that succeeds returns `"completed"`. One that exits with a non-zero code still rejects, as before. A background command, or one still running at its timeout, is returned as `"running"`, and if it later fails it's reported as `"failed"` with its `exitCode`. Every command gets a job id. A command that `bash` returns finished is not pushed as a `<job>` message. Scripts that read the string result should read `output` instead.

The new `waitJob({ id, timeoutMs? })` tool waits for a job and returns its task. The timeout defaults to the `bash` command timeout (10 minutes unless the caller sets one), which is also its maximum. When the wait times out, the task comes back as `"running"` and the command keeps going. Leaving out `bash` also leaves out `waitJob`.

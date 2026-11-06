---
"clanka": minor
---

`bash` now always returns a task, `{ id, status, exitCode?, output }`, the same shape `jobOutput` and `stopJob` return. A command that exits with a non-zero code returns status `"failed"` with its `exitCode` instead of rejecting, so scripts should check `status`. A background command, or one still running at its timeout, is returned as `"running"`. Every command gets a job id. A command that `bash` returns finished is not pushed as a `<job>` message.

The new `waitJob({ id, timeoutMs? })` tool waits for a job and returns its task. The timeout defaults to the `bash` command timeout (10 minutes unless the caller sets one), which is also its maximum. When the wait times out, the task comes back as `"running"` and the command keeps going. Leaving out `bash` also leaves out `waitJob`.

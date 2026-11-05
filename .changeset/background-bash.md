---
"clanka": minor
---

The `bash` tool can run commands in the background. Pass `background: true` to start a command and get a job id back straight away. A foreground command that is still running at its timeout is no longer killed: it is moved to the background, and the call returns the output so far with the job id. New `jobOutput(id)` and `stopJob(id)` tools return a job's status, exit code and output. Jobs belong to the executor and stop when it shuts down. Leaving out `bash` also leaves out both job tools. `gh` still stops at its timeout.

# Background bash commands

## Overview

`bash` can run a command in the background, and a command that reaches its
timeout is handed over to the background instead of being killed. Script
variables do not carry over between executions, so background commands are
addressed by the job ID that `bash` returns.

## Script API

```ts
bash({ command, timeoutMs?, background? }): string
jobOutput(id): { id, status, exitCode?, output }
stopJob(id): { id, status, exitCode?, output }
```

- `bash` still returns a string, so existing scripts keep working.
- `background: true` starts the command and returns straight away with
  `Started background job <id>.` and a hint naming `jobOutput` and `stopJob`.
- In the foreground, `timeoutMs` is how long to wait before handing the
  command over. It is capped by the caller's command timeout, as before. A
  command still running at that point keeps running. The call resolves
  with the output so far followed by a note giving its job ID. It does not
  reject, and the command is not restarted.
- A foreground command that exits in time behaves as before: it returns its
  output, or rejects when the exit code is not 0.
- `jobOutput` returns the output so far. `stopJob` stops the job and returns
  its final state. An unknown ID fails with a message.
- Status values are `running`, `completed` (exit code 0), `failed` (another
  exit code, or the command could not be run) and `stopped`. `exitCode` is
  set once the command has exited.
- IDs come from a per-executor counter as strings: `"1"`, `"2"`, ...
- `gh` keeps its old behaviour and is stopped at its timeout.

## Lifetime

- Commands run in fibers forked into the executor's scope rather than the
  tool call's, so a job outlives the script that started it. In RPC mode
  the executor is the RPC server.
- A foreground command whose call is interrupted before the timeout, for
  example when the script is cancelled or reaches the script timeout, is
  stopped as before. Only a timeout hand-off or `background: true` makes a
  command a job.
- Jobs are stopped when the executor shuts down.
- Each job keeps the directory it was started in. Its output is limited by
  the caller's `commandOutputChars` in the same way as foreground output:
  the start and end are kept.

## Not included

- Results are not pushed to the model when a job finishes, the way
  `<subagent>` results are. The model reads them with `jobOutput`.
- `taskComplete` does not wait for or reject on running jobs, so long-lived
  commands such as dev servers do not block it.

## Exclusion

Leaving out `bash` also leaves out `jobOutput` and `stopJob`.

# Background bash commands

> Superseded in part by [Shared tasks](./shared-tasks.md): the script API,
> IDs, statuses, push message and executor interfaces below are replaced
> there. The lifetime rules still apply.

## Overview

`bash` can run a command in the background, and a command that reaches its
timeout is handed over to the background instead of being killed. Script
variables do not carry over between executions, so background commands are
addressed by the job ID that `bash` returns.

## Script API

```ts
type Task = { id, status, exitCode?, output }

bash({ command, timeoutMs?, background? }): Task
jobOutput(id): Task
waitJob({ id, timeoutMs? }): Task
stopJob(id): Task
```

- `bash` always returns a task. Every call gets a job ID, so any command can
  be read with `jobOutput`.
- A foreground command that exits in time with exit code 0 returns
  `completed` with its output. One that exits with another code rejects
  with `Command failed with exit code <code>: <output>`, as before, and no
  task is returned.
- `background: true` starts the command and returns the task straight away
  as `running`.
- In the foreground, `timeoutMs` is how long to wait before handing the
  command over. It is capped by the caller's command timeout. A command
  still running at that point keeps running and is returned as `running`
  with the output so far. It is not restarted.
- `waitJob` waits for a job to end and returns its task. `timeoutMs`
  defaults to the caller's command timeout (10 minutes unless the caller
  sets one), which is also its maximum. When it passes first, the task is
  returned as `running` and the command keeps going. Interrupting a wait
  does not stop the job either.
- `jobOutput` returns the output so far. `stopJob` stops the job and returns
  its final state. An unknown ID fails with a message.
- Status values are `running`, `completed` (exit code 0), `failed` (another
  exit code, or the command could not be run) and `stopped`. `exitCode` is
  set once the command has exited. `failed` reaches the model only for
  jobs: a background command, or one handed over at its timeout.
- IDs come from a per-executor counter as strings: `"1"`, `"2"`, ...
- `gh` keeps its old behaviour: it returns its output, rejects on a non-zero
  exit and is stopped at its timeout.

## Lifetime

- Commands run in fibers forked into the executor's scope rather than the
  tool call's, so a job outlives the script that started it. In RPC mode
  the executor is the RPC server.
- A foreground command whose call is interrupted before the timeout, for
  example when the script is cancelled or reaches the script timeout, is
  stopped. Its task reports `stopped`.
- Jobs are stopped when the executor shuts down.
- Each job keeps the directory it was started in. Its output is limited by
  the caller's `commandOutputChars` in the same way as foreground output:
  the start and end are kept.

## Completion pushes

- When a job ends, its final state is pushed to the agent that started it,
  the way `<subagent>` results are. Before its next model call the agent adds
  a user message:

  ```
  <job id="1" status="failed" exitCode="3">
  output, capped like script output
  </job>
  ```

  `exitCode` is left out when the command did not exit on its own.

- A job whose final state was already reported is not pushed: one stopped
  with `stopJob`, or one whose final status `bash`, `jobOutput` or `waitJob`
  returned. A command that `bash` returns finished is never handed to the
  agent at all, so it emits no `JobComplete` event either. The
  executor keeps that flag. The agent claims each job just before pushing it,
  so a `jobOutput` read after the job ended but before the push still wins.
- Pushes wait for the agent's next model call. A running job neither keeps a
  conversation-mode run alive nor wakes a run that is waiting for
  sub-agents, so dev servers and watchers never hold a run open. A job that
  ends after its run is pushed in the agent's next run.
- The agent emits a `JobComplete` output event as soon as the job ends,
  whether or not it is pushed. A job that ends between runs has no run to
  emit on, so its event is held and emitted when the agent's next run
  starts. `clanka acp` reports it as a finished `execute` tool call with the
  id `job-<id>`.
- The executor hands each job to `ExecuteOptions.onJob` as it starts, with
  `await` for its final state and `claim` to mark it reported. Over RPC the
  `execute` stream sends a `Job` part, and the client follows it with the
  `awaitJob` and `claimJob` RPCs.

## Mixed versions

Agents, executors and executor servers of different versions keep working
together. Where one side predates job pushes, the model polls with
`jobOutput` as before.

- `Capabilities.jobPushes` says whether the executor hands jobs to `onJob`.
  The local executor and current executor servers set it. Older servers and
  executors that leave it out decode as `false`.
- The system prompt describes the `<job>` message only when `jobPushes` is
  set. Otherwise it keeps the `jobOutput` and `stopJob` instructions alone,
  so the model is never told to wait for a push that cannot come.
- The `bash` tool description does not mention pushes. The executor renders
  it into `toolsDts` for every client, including older clients that never
  receive `Job` parts, so only the agent's own prompt text can promise them.
- The client opts in to `Job` parts with the optional `watchJobs` key of the
  `execute` payload, which it sets when it has an `onJob`. The server sends
  `Job` parts only then, since an older client cannot decode them and would
  end the script with a defect. Older servers ignore the key.

- The `bash` tool description, rendered by the executor, states that
  `bash` returns a task and rejects when a foreground command fails. The
  system prompt repeats it, and mentions `waitJob`, only when the executor
  offers `waitJob`. An older executor still returns strings, and its
  prompt says nothing about tasks. Both reject on a foreground failure.

## Not included

- `taskComplete` does not wait for or reject on running jobs, so long-lived
  commands such as dev servers do not block it.

## Exclusion

Leaving out `bash` also leaves out `jobOutput`, `waitJob` and `stopJob`.

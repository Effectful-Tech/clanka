# Shared tasks

## Overview

Background bash commands and sub-agents used to be two parallel stacks with
their own result shapes, statuses, ID counters, push messages and script
functions. Both are now tasks: one `Task` shape, one ID space per executor,
one set of script functions, and one push message. Bash tasks and agent
tasks keep their different lifetimes.

This replaces the script API, push and executor sections of
[Background bash commands](./background-bash.md) and
[Background sub-agents](./background-subagents.md). Their lifetime, nesting
and display rules still apply unless stated here.

## Task

```ts
interface Task {
  id: string
  kind: "bash" | "agent"
  status: "running" | "completed" | "failed" | "stopped"
  /** The bash command, or the sub-agent's prompt. */
  description: string
  /** Output so far while running; the final output, or the error, once ended. */
  output: string
  /** bash only: set when the command exited on its own. */
  exitCode?: number
}
```

- `stopped` replaces the sub-agents' `cancelled`. The `SubagentComplete`
  output event keeps `cancelled`, so display code and stored events do not
  change.
- A running agent task has `output: ""`.

## Script API

```ts
bash({ command, timeoutMs?, background? }): Task
subagent({ prompt, background? }): Task
taskOutput(id): Task
waitTasks({ ids, timeoutMs? }): Array<Task>
stopTask(id): void
listTasks(): Array<Task>
messageAgent({ id, message }): void
```

- `bash` always returns a bash task, and every call gets an ID, so any
  command can be read with `taskOutput`. A foreground command that exits 0
  in time returns `completed` with its output. One that exits with another
  code rejects with `Command failed with exit code <code>: <output>`, and no
  task is returned. `background: true` returns the task straight away as
  `running`. A foreground command still running at its timeout keeps running
  and is returned as `running` with the output so far.
- `subagent` in the foreground returns the completed agent task, and a
  failed foreground agent still crashes the script. In the background it
  returns the running agent task.
- `taskOutput`, `waitTasks`, `stopTask` and `listTasks` take tasks of either
  kind. Functions that return tasks return a failed task with
  `status: "failed"`, not thrown.
- `stopTask` stops the task and returns nothing. Use `taskOutput` to read its
  final state.
- `waitTasks` returns the listed tasks in the order of their IDs, once all of
  them have ended or `timeoutMs` has passed. The timeout covers the whole
  call and both kinds. It defaults to the caller's command timeout (10
  minutes unless the caller sets `commandTimeout`), which is also its
  maximum. Tasks still running at the deadline are returned as `running` and
  keep going; interrupting the wait stops nothing either. A model whose
  sub-agents run longer calls `waitTasks` again.
- `waitTasks` requires IDs. The old `waitAgents()` waited for every child; a
  version that waits for every task would hang on a dev server.
- `messageAgent` only addresses agent tasks. On a bash task it fails with a
  message naming the task as a bash task. It returns nothing, without waiting
  for the agent to finish its turn.
- An unknown ID fails with `No task with id "<id>"` and points at
  `listTasks()`.
- `jobOutput`, `waitJob`, `stopJob`, `waitAgents`, `stopAgent` and
  `listAgents` are gone, with no aliases. The model reads the type
  declarations every run.

## IDs and ownership

- The executor allocates every ID from one counter, as numeric strings:
  `"1"`, `"2"`, ... Bash tasks and agent tasks never share an ID. The
  `subagent` handler allocates the ID before it hands the agent to the
  `AgentTasks` of the script, so CLI "Subagent #3" and ACP `subagent-3` keep
  matching the task ID.
- Each task belongs to the agent that started it. `ExecuteOptions.agentId`,
  and the `agentId` key of the `execute` RPC payload, name that agent. The
  Agent gives the root and every sub-agent its own random ID, so agents
  sharing an executor never see each other's tasks, and a sub-agent cannot
  read or stop its parent's dev server.
- The task functions only resolve IDs of the calling agent's tasks. Another
  agent's ID fails like an unknown one. `listTasks` returns the calling
  agent's tasks of both kinds, ordered by ID.
- Scripts run without an `agentId` share the tasks started without one.

## Lifetime

The rules of each kind stay as they were:

- A bash task lives in the executor's scope, outlives the script and the run
  that started it, and stops when the executor shuts down. It never keeps a
  conversation-mode run alive and never blocks `taskComplete`.
- An agent task lives in the run's scope and is interrupted when the run
  ends. While one is running, an idle conversation-mode turn waits for it and
  `taskComplete` fails. The rejection quotes the exact call that waits for
  the running children, for example `waitTasks(["1"])`, and points at
  `stopTask`.

## Pushes

- When a task ends and its final state has not been reported, the agent that
  started it gets a user message before its next model call:

  ```
  <task id="3" kind="bash" status="failed" exitCode="1">
  output, capped like script output
  </task>
  ```

  `exitCode` is left out unless a bash command exited on its own.

- A final state is reported when a task function returned it: `bash`,
  `taskOutput` that saw the final status, or `waitTasks`. `stopTask` also marks
  the task as reported, without returning its final state.
  Foreground agent results are reported by `subagent` itself. Reported tasks
  are not pushed. A bash task that `bash` returns finished is never handed to
  the agent at all, so it emits no `JobComplete` event either. `bash` takes
  one snapshot of a running task before handing it over and returns that
  snapshot, so the final state reaches the model once.
- `waitTasks` reports nothing until the batch is ready to return. A script
  stopped while it waits, for example at its own timeout, never receives the
  batch, so the tasks that ended first are still pushed. In a returned
  batch, ended tasks count as reported, and tasks still running are pushed
  when they end.
- The executor waits for the batch's bash tasks first, up to the deadline,
  without reporting them. It then makes one `AgentTasks.waitTasks` call with
  the time left, which waits for the agents and reports the ones that ended
  together, and reports the bash tasks last. Over RPC only that call's
  single response can be cut off. The order matters: a `waitTasks` call made
  alongside the bash wait would report the agents while a bash task is
  still pending. The `WaitTasks` RPC request carries the time left.
- Both kinds are drained by one loop in the Agent, right before the model
  call. Bash tasks are claimed from the executor at that point, so a
  `taskOutput` read between the end of a task and the push still wins.
- `isInjectedMessage` recognises `<task `, and the `<subagent ` and `<job `
  messages of earlier versions, so ACP history replay hides all of them.

## Prompt

- The `bash` bullet states that `bash` returns a task, rejects when a
  foreground command fails, and reports a failed background task as
  `failed` with its `exitCode`.
- The system prompt has one bullet for tasks. It names only the task
  functions the executor offers, and says that `waitTasks` returns tasks
  still running at its timeout as `running`.
- It describes the `<task>` message only when `Capabilities.taskPushes` is
  set, and otherwise tells the model to check bash tasks with `taskOutput`.
  The `subagent` bullet and the tool descriptions never name the message,
  as the executor renders the tool declarations for clients of every
  version. The `bash` description names no task function, so a caller that
  leaves one out never sees it mentioned.

## Executors

- `AgentTools.AgentTasks` replaces `Subagents`, and `AgentTaskExecutor`
  replaces `SubagentExecutor`. Its functions only receive IDs of agent tasks:
  the executor resolves bash tasks itself.
- `ExecuteOptions.agentTasks` replaces `subagents`. Its `subagent` receives
  the allocated `id` along with `prompt`, `background` and `environment`.
- `ExecuteOptions.onTask` replaces `onJob` and receives a `TaskHandle`
  (`id`, `kind`, `await`, `claim`), which replaces `BackgroundJob`.
  `TaskWatcher` replaces `JobWatcher`.
- `Capabilities.taskPushes` replaces `jobPushes`.
- RPC: the `Job` part becomes `Task { id, kind }`, `awaitJob` / `claimJob`
  become `awaitTask` / `claimTask`, and `watchJobs` becomes `watchTasks`.
  The `Subagent` request carries `id`, and the sub-agent requests become
  `TaskOutput`, `WaitTasks`, `MessageAgent`, `StopTask` and `ListTasks`.
- Clients and executor servers from before this change do not work with
  current ones for sub-agents, so both sides must be upgraded together.

## Exclusion

- Leaving out `subagent` also leaves out `messageAgent`.
- `taskOutput`, `waitTasks`, `stopTask` and `listTasks` stay while `bash` or
  `subagent` is offered, and are left out when both are.

## Not included

- The output events `SubagentStart`, `SubagentComplete` and `JobComplete`,
  and their CLI and ACP rendering, are unchanged.
- The `Task` type is written out in each declaration. A shared `Task`
  declaration needs renderer support.

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
bash({ command, timeoutMs?, background? }): string | Task
delegate({ prompt, background? }): Task
taskOutput(id): Task
waitTasks(ids): Array<Task>
stopTask(id): Task
listTasks(): Array<Task>
messageAgent({ id, message }): Task
```

- `bash` in the foreground returns its output as before. With
  `background: true` it returns the running bash task. A foreground command
  still running at its timeout is moved to the background, and the call
  still returns a string: the output so far and a line naming the task ID.
- `delegate` in the foreground returns the completed agent task, and a
  failed foreground agent still crashes the script. In the background it
  returns the running agent task.
- `taskOutput`, `waitTasks`, `stopTask` and `listTasks` take tasks of either
  kind. `waitTasks` returns the tasks in the order of its IDs. A failed task
  is returned with `status: "failed"`, not thrown.
- `waitTasks` requires IDs. The old `waitAgents()` waited for every child; a
  version that waits for every task would hang on a dev server.
- `messageAgent` only addresses agent tasks. On a bash task it fails with a
  message naming the task as a bash task.
- An unknown ID fails with `No task with id "<id>"` and points at
  `listTasks()`.
- `jobOutput`, `stopJob`, `waitAgents`, `stopAgent` and `listAgents` are gone,
  with no aliases. The model reads the type declarations every run.

## IDs and ownership

- The executor allocates every ID from one counter, as numeric strings:
  `"1"`, `"2"`, ... Bash tasks and agent tasks never share an ID. The
  `delegate` handler allocates the ID before it hands the agent to the
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

- A final state is reported when a task function returned it: `taskOutput`
  that saw the final status, `waitTasks`, or `stopTask`. Foreground agent
  results are reported by `delegate` itself. Reported tasks are not pushed.
- `waitTasks` reports nothing until every task in the batch has ended. A
  script stopped while it waits, for example at its timeout, never receives
  the batch, so the tasks that ended first are still pushed.
  The executor waits for the batch's bash tasks first, without reporting
  them. It then makes one `AgentTasks.waitTasks` call, which waits for the
  agents and reports them together, and reports the bash tasks last. Over
  RPC only that call's single response can be cut off. The order matters:
  a `waitTasks` call made alongside the bash wait would report the agents
  while a bash task is still pending.
- Both kinds are drained by one loop in the Agent, right before the model
  call. Bash tasks are claimed from the executor at that point, so a
  `taskOutput` read between the end of a task and the push still wins.
- `isInjectedMessage` recognises `<task `, and the `<subagent ` and `<job `
  messages of earlier versions, so ACP history replay hides all of them.

## Prompt

- The system prompt has one bullet for tasks. It names only the task
  functions the executor offers.
- It describes the `<task>` message only when `Capabilities.taskPushes` is
  set, and otherwise tells the model to check bash tasks with `taskOutput`.
  The `delegate` bullet and the tool descriptions never name the message, as
  the executor renders the tool declarations for clients of every version.

## Executors

- `AgentTools.AgentTasks` replaces `Subagents`, and `AgentTaskExecutor`
  replaces `SubagentExecutor`. Its functions only receive IDs of agent tasks:
  the executor resolves bash tasks itself.
- `ExecuteOptions.agentTasks` replaces `subagents`. Its `delegate` receives
  the allocated `id` along with `prompt`, `background` and `environment`.
- `ExecuteOptions.onTask` replaces `onJob` and receives a `TaskHandle`
  (`id`, `kind`, `await`, `claim`), which replaces `BackgroundJob`.
  `TaskWatcher` replaces `JobWatcher`.
- `Capabilities.taskPushes` replaces `jobPushes`.
- RPC: the `Job` part becomes `Task { id, kind }`, `awaitJob` / `claimJob`
  become `awaitTask` / `claimTask`, and `watchJobs` becomes `watchTasks`.
  The `Delegate` request carries `id`, and the sub-agent requests become
  `TaskOutput`, `WaitTasks`, `MessageAgent`, `StopTask` and `ListTasks`.
- Clients and executor servers from before this change do not work with
  current ones for sub-agents, so both sides must be upgraded together.

## Exclusion

- Leaving out `delegate` also leaves out `messageAgent`.
- `taskOutput`, `waitTasks`, `stopTask` and `listTasks` stay while `bash` or
  `delegate` is offered, and are left out when both are.

## Not included

- The output events `SubagentStart`, `SubagentComplete` and `JobComplete`,
  and their CLI and ACP rendering, are unchanged.
- `bash` renders as one signature returning `Promise<string | Task>`, and the
  `Task` type is written out in each declaration. Overloads keyed on
  `background: true` and a shared `Task` declaration need renderer support.

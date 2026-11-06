---
"clanka": minor
---

Background bash commands and sub-agents are now both tasks. `bash` and `delegate` return a `Task` (`id`, `kind`, `status`, `description`, `output`, `exitCode?`), and the shared `taskOutput`, `waitTasks`, `stopTask` and `listTasks` functions work on either kind. `bash` keeps the behaviour of 0.21.0: it always returns a task, and a failing foreground command rejects.

`waitTasks({ ids, timeoutMs? })` waits for tasks of either kind and replaces `waitJob`. The timeout covers the whole call; it defaults to the `bash` command timeout (10 minutes unless the caller sets one), which is also its maximum. Tasks still running when it passes come back as `"running"` and keep going, sub-agents included. Results are reported only when the whole batch returns, so a script stopped while it waits loses nothing: the tasks that ended are still pushed. `messageAgent` stays for sub-agents. Ended tasks are pushed to the model as one `<task id="…" kind="…" status="…">` message, unless a task function already returned their final state.

Every task ID now comes from one counter per executor, and a task is only visible to the agent that started it: `ExecuteOptions.agentId` and the `agentId` key of the `execute` RPC name that agent. The status `cancelled` is now `stopped`; the `SubagentComplete` output event keeps `cancelled`.

Breaking changes:

- The script functions `jobOutput`, `waitJob`, `stopJob`, `waitAgents`, `stopAgent` and `listAgents` are removed, along with their `excludeTools` names. A wait on sub-agents is now bounded, where `waitAgents()` waited without limit. Leaving out `delegate` leaves out `messageAgent`, and leaving out both `delegate` and `bash` leaves out the task functions.
- `AgentTools`: `Task`, `TaskKind`, `TaskStatus`, `AgentTasks`, `AgentTaskExecutor`, `agentTasksUnavailable`, `TaskHandle`, `TaskWatcher` and `TaskOwner` replace `BashJob`, `BashJobStatus`, `SubagentStatus`, `SubagentResult`, `DelegateResult`, `SubagentInfo`, `Subagents`, `SubagentExecutor`, `subagentsUnavailable`, `BackgroundJob` and `JobWatcher`.
- `AgentExecutor`: `ExecuteOptions.agentTasks` replaces `subagents`, its `delegate` receives the task `id`, and its `waitTasks` receives the time left as `timeoutMs`; `ExecuteOptions.onTask` replaces `onJob`; `Capabilities.taskPushes` replaces `jobPushes`. The RPC protocol changes to match, so clients and executor servers must be upgraded together.

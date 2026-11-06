---
"clanka": minor
---

Background bash commands and sub-agents are now both tasks. `bash({ background: true })` and `delegate` return a `Task` (`id`, `kind`, `status`, `description`, `output`, `exitCode?`), and the shared `taskOutput`, `waitTasks(ids)`, `stopTask` and `listTasks` functions work on either kind. `messageAgent` stays for sub-agents. Ended tasks are pushed to the model as one `<task id="…" kind="…" status="…">` message, unless a task function already returned their final state.

Every task ID now comes from one counter per executor, and a task is only visible to the agent that started it: `ExecuteOptions.agentId` and the `agentId` key of the `execute` RPC name that agent. The status `cancelled` is now `stopped`; the `SubagentComplete` output event keeps `cancelled`.

Breaking changes:

- The script functions `jobOutput`, `stopJob`, `waitAgents`, `stopAgent` and `listAgents` are removed, along with their `excludeTools` names. Leaving out `delegate` leaves out `messageAgent`, and leaving out both `delegate` and `bash` leaves out the task functions.
- `AgentTools`: `Task`, `TaskKind`, `TaskStatus`, `AgentTasks`, `AgentTaskExecutor`, `agentTasksUnavailable`, `TaskHandle`, `TaskWatcher` and `TaskOwner` replace `BashJob`, `BashJobStatus`, `SubagentStatus`, `SubagentResult`, `DelegateResult`, `SubagentInfo`, `Subagents`, `SubagentExecutor`, `subagentsUnavailable`, `BackgroundJob` and `JobWatcher`.
- `AgentExecutor`: `ExecuteOptions.agentTasks` replaces `subagents` and its `delegate` receives the task `id`; `ExecuteOptions.onTask` replaces `onJob`; `Capabilities.taskPushes` replaces `jobPushes`. The RPC protocol changes to match, so clients and executor servers must be upgraded together.

---
"clanka": minor
---

Add background sub-agents. `delegate({ prompt, background: true })` returns straight away with an agent ID while the sub-agent keeps working, and its result is pushed to the parent as a `<subagent id="..." status="...">` message before the next model call. New script functions `waitAgents`, `messageAgent`, `stopAgent` and `listAgents` manage an agent's own children. Sub-agents are scoped to the parent's run, and `taskComplete` fails while children are still running.

Breaking changes:

- `delegate` now takes an options object and returns `{ id, status, output }`. A bare string is rejected, so custom `system` prompts or skills that show `delegate("...")` need updating to `delegate({ prompt: "..." })` and read `.output`.
- `AgentExecutor.execute` takes `subagents` instead of `onSubagent`, and `onTaskComplete` may fail with a message. The `SubagentExecutor` service now provides the `Subagents` interface.
- The executor RPC protocol replaced the `Subagent` / `subagentOutput` pair and the `TaskComplete` event with a `Request` event and a `respond` RPC. Client and server must be upgraded together.

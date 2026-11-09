---
"clanka": minor
---

Rename the `delegate` tool to `subagent`. Update scripts, custom prompts, `excludeTools` entries and `agentTasks` handlers to use `subagent`; its options and task results are unchanged.
The executor RPC request tag is now `Subagent` instead of `Delegate`, so update RPC clients and servers together.

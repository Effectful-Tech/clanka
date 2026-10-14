---
"clanka": minor
---

Let callers choose what the model is offered, and add loop-side tools.

- `AgentExecutor.layerLocal`, `AgentExecutor.layerRpcServer` and `Agent.layerLocal` take `excludeTools` to leave out built-in tools. A left-out tool is not in the sandbox, the type declarations or the system prompt. Leaving out `delegate` also leaves out `waitAgents`, `messageAgent`, `stopAgent` and `listAgents`.
- `Agent.makeWith` and `Agent.layerWith` take `instructions` (replace or remove the executor's `AGENTS.md`), `skills` (caller-supplied skills, read with a loop-side `readSkill` function) and `loopTools`, an Effect `Toolkit` whose handlers run next to the Agent. Calls are decoded against the tool's schema before the handler runs, and a handler failure rejects the script's call with its message. In RPC mode the call travels from the executor to the loop over the existing `Request` / `respond` pair.
- `SubagentModel` is optional. Without it, sub-agents run on the parent's model.
- `Capabilities` gains `tools`, the names of the functions the executor offers.

`Agent.make`, `Agent.layer`, the CLI and ACP keep today's behaviour. The `execute` RPC gains a `loopTools` field and `AgentRequest` gains `LoopTool`; both decode with defaults, but a loop that uses loop-side tools needs an executor on this version.

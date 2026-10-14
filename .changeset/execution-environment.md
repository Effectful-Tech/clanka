---
"clanka": minor
---

Give every agent its own working directory.

Before, `changeDirectory` changed one directory shared by the whole executor. Concurrent sub-agents, and every session served by one `layerRpcServer`, could resolve paths against each other's directory.

- `AgentExecutor.ExecutionEnvironment` holds the executor state for one agent, starting with its working directory. Only the executor reads its fields.
- `ExecuteOptions` gains `environment`, the environment the script starts in, and `onEnvironment`, which receives an `EnvironmentUpdate` once when the script ends, including on failure, timeout and interrupt.
- `Capabilities` gains `environment`, the environment of an agent's first script.
- `Agent` gains `environment`, a `MutableRef` the agent passes to each script and replaces with what the executor returns. A sub-agent starts with a copy of its parent's environment at the moment `delegate` is called, so `changeDirectory` followed by `delegate` in one script starts the sub-agent in the new directory.
- `ExecuteOptions.subagents` is now an `ExecuteSubagents`, whose `delegate` also receives the new agent's `environment`.
- `executeUnsafe` takes an optional `environment`, defaulting to the startup environment.
- ACP stores the environment in `SessionRecord` and restores it on `session/load`, so the working directory survives a reload. It is discarded when the load's `cwd` differs from the stored one.

The executor RPC protocol gains a required `Capabilities.environment` field, an `execute` `environment` field, an `Environment` stream member and an `environment` field on `AgentRequest.Delegate`, so the executor's client and server must be upgraded together.

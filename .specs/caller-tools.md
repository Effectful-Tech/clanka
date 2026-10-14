# Caller-selected tools, instructions, skills and loop-side tools

## Overview

A caller decides what the model is offered: which built-in tools exist, where
the project instructions and skills come from, and a set of tools whose
handlers run next to the `Agent` instead of inside the executor.

Two sides own two kinds of configuration:

- The **executor** owns the script sandbox and the type declarations the model
  sees, so leaving out built-in tools is configured where the executor is
  built: `AgentExecutor.layerLocal`, `AgentExecutor.layerRpcServer` and
  `Agent.layerLocal`.
- The **Agent** owns the system prompt and runs in the trusted process, so
  instructions, skills and loop-side tools are configured where the Agent is
  built: `Agent.makeWith`, `Agent.layerWith` and `Agent.layerLocal`.

Existing callers keep today's behaviour: `Agent.make` and `Agent.layer` are
unchanged, every built-in tool is offered, `AGENTS.md` and `.agents/skills`
come from the executor's checkout.

## Executor: leaving out built-in tools

```ts
AgentExecutor.layerLocal({ directory, tools?, excludeTools? })
AgentExecutor.layerRpcServer({ directory, tools?, excludeTools? })
Agent.layerLocal({ directory, tools?, excludeTools?, ...Agent.Options })
```

- `excludeTools` lists built-in tool names (`AgentTools.ExcludableTool`, every
  built-in except `taskComplete`). A listed tool is not in the sandbox, not in
  `Capabilities.toolsDts`, and not named by the system prompt prose. Calling
  it from a script throws, as any undefined function would.
- `"delegate"` also removes `waitAgents`, `messageAgent`, `stopAgent` and
  `listAgents`: they only address agents started by `delegate`.
- `Capabilities` gains `tools: ReadonlyArray<string>`, the names of the script
  functions the executor offers, so the Agent can gate prompt prose on them.
  It decodes to `[]` when an older executor leaves it out.

## Agent: sub-agent model

`SubagentModel` is no longer in the requirements of `Agent.send`. The Agent
reads it with `Effect.serviceOption`; when it is absent, sub-agents run on the
parent's model services. A caller that leaves out `delegate` therefore
provides nothing for sub-agents, and a caller that keeps it may still choose
to provide `Agent.layerSubagentModel` as before.

## Agent: instructions, skills and loop-side tools

```ts
interface Agent.Options<LoopTools extends Toolkit.Any = never> {
  readonly instructions?: Option.Option<string> | undefined
  readonly skills?: ReadonlyArray<AgentSkills.ProvidedSkill> | undefined
  readonly loopTools?: LoopTools | undefined
}

Agent.makeWith(options): Effect<Agent, never, Scope | AgentExecutor | Agent.LoopToolServices<LoopTools>>
Agent.layerWith(options): Layer<Agent, never, AgentExecutor | Agent.LoopToolServices<LoopTools>>
Agent.make  === Agent.makeWith({})
Agent.layer === Agent.layerWith({})
```

### Instructions

- Unset: the executor's `AGENTS.md` goes into the system prompt, as today.
- `Option.some(text)`: `text` goes into the system prompt in its place, under
  a heading that does not claim it came from `./AGENTS.md`.
- `Option.none()`: no project instructions.
- The `system` function passed to `send` keeps receiving the chosen text as
  `agentsMd`.

### Skills

```ts
class AgentSkills.ProvidedSkill { name: string; description: string; content: string }
```

- Unset: skills discovered on the executor, as today.
- A list, possibly empty: exactly these skills are offered. Nothing is read
  from the executor's filesystem.
- The catalog lists each name and description and tells the model to call
  `readSkill(name)` before a matching task. `readSkill` is a loop-side tool the
  Agent adds when skills are provided; it returns the skill's `content` and
  fails with the available names when the name is unknown. The content stays
  on the loop side until a script asks for it: the executor never sees it,
  and the prompt is not inflated by every skill on every turn.
- A provided skill is one document. Relative references inside it have no
  files to resolve to; a later change can add them.

### Loop-side tools

- `loopTools` is an Effect `Toolkit`. The handlers come from the environment of
  `makeWith` / `layerWith`, exactly as executor `tools` do, through
  `Toolkit.toLayer`.
- The tools are rendered into the type declarations after the executor's
  tools, with their descriptions and schemas, so the model calls them like any
  other function.
- Every call is decoded against the tool's parameters schema with
  `Toolkit.handle` before the handler runs. A decoding failure rejects the
  script's call with a message naming the tool and the problem; the handler is
  not invoked. The handler's success is encoded with the success schema and
  becomes the resolved value in the script.
- A handler failure (`failure` schema, typically `Schema.String`) rejects the
  script's call with that value as the message, so the model can fix the call
  while it still has context. A defect in a handler also rejects the call,
  with the defect's message.
- A loop-side tool named like an executor tool is a defect when the Agent is
  built.
- Handlers run in the fiber of the `execute` call that the script belongs to.
  Concurrent calls from one script and calls from concurrent scripts run
  concurrently. Interrupting the run interrupts in-flight handlers, in both
  executor modes.

## Executor contract

```ts
interface ExecuteOptions {
  ...
  readonly loopTools?: AgentExecutor.LoopToolHandlers | undefined
}

type LoopToolHandlers = Readonly<Record<string, (params: unknown) => Effect<unknown, string>>>
```

- The sandbox gets one function per key. The function passes its single
  argument, undecoded, to the handler; a success resolves the promise and a
  failure rejects it with the string as the error message.
- The Agent builds `loopTools` from its toolkit: decoding, the handler and
  result encoding are wrapped into each function, so the executor stays
  schema-free.

## RPC protocol

- `execute` takes `{ script, loopTools: Array<string> }`. The names are the
  functions to put in the sandbox; it decodes to `[]` when absent.
- `AgentRequest` gains `LoopTool: { name: string; params: Json | undefined }`.
  It travels on the existing `Request` event and is answered with the existing
  `respond` RPC, whose `Failure.message` is the rejection the script sees.
  Request IDs come from the server-wide counter, so concurrent scripts and
  nested execute streams never collide, and the client forks each handler into
  the execute stream's scope, so interrupting the stream interrupts them.

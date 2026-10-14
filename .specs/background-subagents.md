# Background sub-agents

## Overview

`delegate` can start a sub-agent in the background. The sub-agent keeps
running after the script that started it ends, while the parent takes more
turns. Script variables do not carry over between executions, so agents are
addressed by the ID that `delegate` returns.

## Script API

```ts
delegate({ prompt, background? }): { id, status: "completed" | "running", output? }
waitAgents(ids?): Array<{ id, status, output? }>
messageAgent({ id, message }): { id, status, output? }
stopAgent(id): { id, status, output? }
listAgents(): Array<{ id, status, prompt }>
```

- `delegate` takes an options object. A bare string is rejected with a
  message showing the new form.
- Foreground (the default) waits for the agent and returns `completed` with
  its output. A failed foreground agent crashes the script.
- `background: true` returns straight away with `running` and no output.
- `waitAgents` waits for the listed agents, or every child when no IDs are
  passed. A failed agent is returned with `status: "failed"` and its error as
  the output; it does not throw.
- `messageAgent` steers a running agent through that agent's own message
  queue. On a finished agent it starts a new turn on top of the agent's saved
  history. It never waits; the result arrives as a completion push.
- `stopAgent` interrupts the agent and everything under it, and returns
  `cancelled`.
- Status values are `completed`, `running`, `failed` and `cancelled`.
- IDs come from the global agent counter as strings, matching "Subagent #3"
  in the CLI and `subagent-3` in ACP.

## Lifetime

- Sub-agents are forked into a scope owned by the parent's run, not the
  script. When the run ends, for any reason, they are interrupted.
- Each sub-agent keeps its history for the length of the run, so
  `messageAgent` can resume it.
- `taskComplete` fails while the agent's own children are running. The error
  lists their IDs and points at `waitAgents` / `stopAgent`. Nothing is waited
  for or cancelled automatically.
- In conversation mode, a turn with no tool call does not end the run while
  children are running or their results have not been delivered. The run
  blocks until a completion arrives, then starts a new model turn.

## Completion delivery

- When a background turn finishes, its result goes into a queue separate from
  steering messages. The queue is drained at the top of the parent's loop,
  before the next model call, so a push never cuts off a model response.
- Each result becomes a user message:
  `<subagent id="3" status="completed">…</subagent>`, with the output run
  through `Compaction.capOutput`.
- Results the model has already seen are not pushed: foreground results,
  results returned by `waitAgents`, and agents stopped with `stopAgent`.

## Nesting

Every agent gets the full set of functions, scoped to its own children. An
agent can only address agents it spawned, and pushes go to the spawning agent.
The `taskComplete` rule and the cascading stop apply at every level. There is
no concurrency cap and no depth limit.

## Display

- CLI: background agents show only start and complete / failed / cancelled
  lines. Their output is not streamed, so they never hold the output lock.
- ACP: a sub-agent is a `tool_call` that stays `in_progress` until it
  finishes, then becomes `completed` or `failed`.
- `SubagentStart` has a `background` flag and `SubagentComplete` has a
  `status`. Both default when decoding older events.

## Executors

`AgentExecutor.execute` takes a `subagents` object (the `Subagents` interface
in `AgentTools`) in place of `onSubagent`, and `onTaskComplete` can fail with
a message for the script.

The RPC protocol replaces the `Subagent` / `subagentOutput` pair and the
`TaskComplete` event with a generic `Request` event and a `respond` RPC.
Requests cover `taskComplete` and all five sub-agent functions; background
`delegate` requests are answered as soon as the agent has started.

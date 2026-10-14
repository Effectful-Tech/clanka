---
"clanka": minor
---

Send AGENTS.md files and skills to the model when an agent changes directory, without changing the system prompt.

After a script, the executor looks for AGENTS.md files and `.agents/skills` from the agent's directory up to the startup directory, or up to the git root outside it. Anything the model has not seen yet is added to the history as an `<environment-update>` user message, after the tool result. The system prompt stays the same, so the prompt cache still hits. Compaction and new sub-agents get the instructions for the current directory again, and ACP no longer replays these messages, or `<subagent>` results, as if the user had typed them.

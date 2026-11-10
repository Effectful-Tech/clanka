---
"clanka": minor
---

Add a string-only `run(command)` tool that returns bash output. Commands start in the foreground and move to the background after two minutes (or a shorter caller command limit), returning a still-running notice instead of a Task object.

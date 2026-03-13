---
"clanka": minor
---

Add an optional `timeout` field to the `bash` tool parameters and change the `bash` tool input shape to `{ command, timeout? }` (with `command` as the parameter name in rendered typings).

The timeout is specified in seconds and defaults to 120 seconds.

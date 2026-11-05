---
"clanka": patch
---

Fix bash and gh tool calls being interrupted in `clanka acp` sessions. The session's executor is now built in the session scope, so the scope its commands run in stays open.

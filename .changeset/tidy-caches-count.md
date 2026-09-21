---
"clanka": minor
---

Report cumulative cache read and write tokens on usage events and the ACP usage extension. `Usage` now requires both fields.

Those counts are included in `inputTokens`, not added to them. Zero does not distinguish an unreported value from no cache activity.

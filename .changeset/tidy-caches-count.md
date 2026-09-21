---
"clanka": minor
---

Include cumulative, provider-reported cache read and cache write token counts in Clanka usage events and the existing ACP usage extension. Cache counts are provider-specific breakdowns of input usage, not extra input tokens. Zero is the total of values reported by providers; it does not distinguish unreported usage from no cache activity. This is a breaking change because both fields are required when constructing or decoding `Usage`.

---
"clanka": patch
---

Retry model responses that failed without making a tool call, or that would end a conversation-mode turn with no text and no tool call, instead of ending the turn with an empty answer. Retries use the existing `MaxRetries` limit. A failed response that made a tool call keeps the call and its result, and the turn continues.

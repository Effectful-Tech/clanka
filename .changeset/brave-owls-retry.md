---
"clanka": patch
---

Retry model responses that failed, or that would end a conversation-mode turn with no text and no tool call, instead of ending the turn with an empty answer. Retries use the existing `MaxRetries` limit.

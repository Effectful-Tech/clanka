---
"clanka": patch
---

End a conversation-mode turn when the model response finishes with no text and no tool call, instead of retrying it until `RetriesExhausted`. Responses that fail or stop before they finish are still retried.

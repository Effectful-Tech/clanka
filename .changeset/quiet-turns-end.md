---
"clanka": patch
---

Start another model turn when a conversation-mode response finishes with no text and no tool call, instead of retrying it as an error until `RetriesExhausted`. Responses that fail or stop before they finish are still retried.

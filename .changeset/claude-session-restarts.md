---
"clanka": minor
---

Codex requests now send a `prompt_cache_key` per model, and a `SessionRestarted` output part reports when the Claude provider had to resend the whole history and what that cost. Steering a Claude agent no longer restarts its Claude Code session.

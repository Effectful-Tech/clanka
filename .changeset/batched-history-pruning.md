---
"clanka": minor
---

Prune old `execute` results and reasoning from the history in batches before compaction, so long sessions send fewer tokens per turn and provider caches are invalidated once per batch instead of every turn. Pruning is tuned with the new `pruneProtectTokens` and `pruneMinimumTokens` compaction options, and reported with a `HistoryPruned` output part.

Codex requests now send a `prompt_cache_key` per model, and a `SessionRestarted` output part reports when the Claude provider had to resend the whole history and what that cost. Steering a Claude agent no longer restarts its Claude Code session.

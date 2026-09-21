---
"clanka": patch
---

Report ACP models as canonical `provider:model` IDs and expose reasoning effort through the `thought_level` config option. ACP sessions now persist the canonical model and thought level separately. Existing saved ACP sessions use the old shape and cannot be loaded after this update.

Multica model or pricing overrides keyed by an old effort-bearing ID should be updated to the canonical ID so new usage is not attributed to the old key. The pricing match was verified against Multica's source catalog and aliases; no live usage-ingestion verification or workspace configuration migration is included.

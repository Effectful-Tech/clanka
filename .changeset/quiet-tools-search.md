---
"clanka": patch
---

Allow `rg` wildcard glob searches that name a directory to retry with ignored and hidden files when the normal search returns no matches. The fallback is skipped when the normal search finds any matches, so partial results can omit matching files from ignored directories.

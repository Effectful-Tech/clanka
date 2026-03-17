---
"clanka": patch
---

Add a new `CodeChunker` service that uses `rg --files` to discover codebase files, filters out non-meaningful artifacts (lock files, minified assets, generated folders), and emits hashed line-based code chunks for source and documentation files.

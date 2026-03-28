---
"clanka": patch
---

Fix script preprocessing to follow assignment root identifiers so template literals are escaped even when a writeFile content value is derived from another variable (e.g. `content = spec.replaceAll(...)`). This resolves the failing patch20 preprocessing fixture.

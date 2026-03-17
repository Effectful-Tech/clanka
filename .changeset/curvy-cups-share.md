---
"clanka": patch
---

Update `chunkFileContent` to skip non-meaningful leading lines in each chunk window, so emitted chunks always start on a line containing non-whitespace, non-punctuation content.

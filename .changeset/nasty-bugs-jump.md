---
"clanka": patch
---

Fix script preprocessing for tool-call templates by selecting the last matching template delimiter instead of the first. This prevents premature termination when writeFile content contains markdown inline code spans with commas, and correctly escapes all internal backticks.

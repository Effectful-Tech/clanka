---
"clanka": patch
---

Fix script preprocessing for non-patch template literals that contain doubly escaped markdown markers (for example, \\`code\\`). These are now normalized to single escaped markers before preprocessing so task summaries remain stable and valid. Also fix assigned template detection to correctly handle multiline patch literals that close at end-of-line, ensuring trailing backticks inside patch content are escaped.

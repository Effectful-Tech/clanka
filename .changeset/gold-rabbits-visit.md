---
"clanka": patch
---

Fix SemanticSearch embedding resolver wiring so `embeddingRequestDelay` controls `RequestResolver.setDelay` (defaulting to 50ms), instead of incorrectly deriving delay from `embeddingBatchSize`. Add regression tests for explicit and default delay behavior.

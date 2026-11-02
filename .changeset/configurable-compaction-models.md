---
"clanka": minor
---

Compact earlier, at 160k tokens by default, through the new `thresholdTokens` compaction option. The CLI and `clanka acp` take `--compaction-threshold` (or `CLANKA_COMPACTION_THRESHOLD`).

Sub-agents and the compaction summarizer can run on a different model than the agent with `--subagent-model` and `--summarizer-model` (or `CLANKA_SUBAGENT_MODEL` and `CLANKA_SUMMARIZER_MODEL`). Library users can provide `Compaction.layerSummarizerModel`, and pass the models to `ModelLayer.make` and `ModelLayer.makeAcp`.

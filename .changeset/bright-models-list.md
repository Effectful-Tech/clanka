---
"clanka": minor
---

Build the model list from models.dev. A new `ModelsRepo` service lists the chat models clanka can run, and `ModelsRepo.layerModelsDev` fetches them from `https://models.dev/api.json`, caching the catalog in the `KeyValueStore` for 24 hours. `clanka` without `--model` now offers a searchable model picker and a reasoning effort picker, and `clanka acp` advertises the catalog in `availableModels`.

`Codex`, `Xai` and `Copilot` models accept `reasoning: null` to send no reasoning options, which the CLI and `clanka acp` use for catalog models that list no efforts. Omitting `reasoning` keeps the default effort. `clanka acp` runs a catalog model at its supported effort nearest the session thought level, preferring the higher one on a tie, when the model does not support that level.

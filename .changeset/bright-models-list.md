---
"clanka": minor
---

Build the model list from models.dev. A new `ModelsRepo` service lists the chat models clanka can run, and `ModelsRepo.layerModelsDev` fetches them from `https://models.dev/api.json`, caching the catalog in the `KeyValueStore` for 24 hours. `clanka` without `--model` now offers a model and reasoning effort picker, and `clanka acp` advertises the catalog in `availableModels`.

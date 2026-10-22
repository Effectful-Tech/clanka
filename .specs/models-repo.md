# Models catalog from models.dev

## Overview

The `clanka` CLI and `clanka acp` currently know no models: the interactive
prompt takes a free-form `<model>/<effort>` string with a hard-coded default,
and the ACP server advertises only the session's own model and the default.
A `ModelsRepo` service supplies the catalog of chat models clanka can run,
and its `models.dev` implementation builds that catalog from
`https://models.dev/api.json`.

Out of scope: validating a typed model against the catalog (a model id stays
opaque to ACP and is resolved by `makeModel`, so models that models.dev does
not list yet keep working); pricing, context limits and modalities beyond what
is needed to pick a model; providers other than `openai`, `copilot` and `xai`;
refreshing the catalog while the process runs.

## Library: `ModelsRepo`

```ts
class ModelInfo {
  provider: "openai" | "copilot" | "xai"  // clanka provider, as --provider takes it
  id: string                               // model id as the provider API expects it
  name: string                             // display name
  efforts: ReadonlyArray<Acp.ThoughtLevel> // reasoning efforts the model accepts, [] if none
}

interface ModelsRepo {
  readonly models: Effect<ReadonlyArray<ModelInfo>>
}

ModelsRepo.layer(models: ReadonlyArray<ModelInfo>): Layer<ModelsRepo>
ModelsRepo.layerModelsDev(options?: { url?: string; ttl?: Duration.Input }):
  Layer<ModelsRepo, never, HttpClient | KeyValueStore>
ModelsRepo.fallback: ReadonlyArray<ModelInfo>
```

- `models` never fails. The models.dev layer serves the live catalog, then the
  last catalog it cached, then `fallback`, logging a warning when it falls back.
  A CLI without network still starts.
- `layer` wraps a fixed list; tests and embedders use it.
- `fallback` is the built-in list of the three defaults the CLI shipped with
  (`openai/gpt-6-astra`, `copilot/gpt-6-astra`, `xai/grok-4.6`).

### models.dev mapping

`api.json` is keyed by models.dev provider id, each holding a `models` record.
Only three providers are read, in this order:

| models.dev       | clanka    |
| ---------------- | --------- |
| `openai`         | `openai`  |
| `github-copilot` | `copilot` |
| `xai`            | `xai`     |

A model is kept when it is a text model (no `type` field; `image`, `embedding`,
`realtime` and `video` entries are dropped), is not `status: "deprecated"` and
has `tool_call: true` — clanka drives every turn through a tool call. Models
keep their `api.json` order within a provider.

`efforts` is the `values` of the `reasoning_options` entry with
`type: "effort"`, filtered to `Acp.ThoughtLevel` literals. Models without an
effort option get `[]`.

### Caching

`api.json` is about 6 MB. The layer decodes it with a `Schema` that reads only
the fields above and stores the resulting `ModelInfo` list, not the response,
in the `KeyValueStore` under the `models-dev/` prefix together with the fetch
time. A cached catalog younger than `ttl` (default 24 hours) is served without
a request; an older one is refreshed, and kept if the refresh fails.

## CLI

- `clanka` with no `--model`: a `Prompt.Select` over the catalog entries for
  the chosen provider, then a `Prompt.Select` over that model's `efforts`
  (preselecting `medium` when offered). `--model <model>/<effort>` is unchanged
  and is not checked against the catalog.
- `clanka acp`: `Acp.Options` gains `availableModels`, an
  `Effect<ReadonlyArray<{ modelId: string; name: string }>>`. The CLI passes the
  catalog as `<provider>:<id>` ids named `<ModelInfo.name> (<provider>)`,
  since providers share model names.
  `sessionState` lists `availableModels` first, then the session model and
  the default model when the catalog does not already list them, so sessions
  on an unlisted model keep a valid `currentModelId`. Without the option the
  server keeps advertising only the session and default model.
- `ModelsRepo.layerModelsDev()` is provided at the CLI root next to `Kvs` and
  `HttpClientLive`, so the cache lives in `~/.config/clanka`.

## Tests

- `src/ModelsRepo.test.ts`: the mapping from a small `api.json` fixture
  (provider renaming, dropped entries, effort filtering), and that a repo built
  over a failing `HttpClient` serves the catalog a previous repo cached in the
  same `KeyValueStore`.
- `src/Acp.test.ts`: `session/new` advertises the catalog given through
  `availableModels`.

# Specifications

## Projects

- [TypeBuilder](./type-builder.md) - Generate TypeScript type expressions from
  Effect Schema definitions. Ports the original `TypeBuilder.ts` to work with
  Effect v4's restructured SchemaAST.
- [OpenAI Codex Auth](./openai-codex-auth.md) - Authenticate with OpenAI's
  Codex API via the headless device auth flow, using `@effect/ai-openai` as
  the provider layer. Includes token storage via `KeyValueStore`, automatic
  refresh, and a fully wired `LanguageModel` layer.

# Google Antigravity provider

## Overview

An `antigravity` provider runs the models of a Google Antigravity
subscription through Cloud Code (`daily-cloudcode-pa.googleapis.com/v1internal`),
the API the Antigravity app uses. clanka signs in with Google OAuth as the
Antigravity app, finds or sets up the account's Cloud Code project, and
sends Gemini `generateContent` requests for every model, Claude and GPT-OSS
included. The protocol follows `CLIProxyAPI`'s Antigravity executor.

Out of scope: discovering the account's models with `fetchAvailableModels`;
quota display; image generation models; fast mode; switching between
several Google accounts.

## Library

```ts
// OAuthCallback
class OAuthCallback {
  receive(options: { url: string; redirectUri: string }):
    Effect<URLSearchParams, OAuthCallbackError>
}
layerLoopback(notify: (url: string) => Effect<void>): Layer<OAuthCallback>
layerConsole, layerLog: Layer<OAuthCallback>

// AntigravityAuth
class TokenData { access; refresh; expires; project }
class AntigravityAuth {
  get: Effect<TokenData, AntigravityAuthError>
  authenticate: Effect<TokenData, AntigravityAuthError>
  logout: Effect<void>
  static layer: Layer<AntigravityAuth, never, HttpClient | KeyValueStore | OAuthCallback>
}

// Antigravity
class AntigravityClient {
  streamGenerateContent(options: { model; request: GenerateContentRequest }):
    Stream<GenerateContentChunk, AiError>
  static layer: Layer<AntigravityClient, never, HttpClient | KeyValueStore | OAuthCallback>
}
class MaxOutputTokens extends Context.Reference<number | undefined>
model(model: string, options?: { reasoning?: { effort?: string } | null } & AgentModelConfig):
  Model<"antigravity", LanguageModel, AntigravityClient>
```

## Sign-in

- `layerLoopback` listens on the redirect URI's host and port, shows the
  authorization URL through `notify`, answers 404 to requests without a
  `code` or `error` on the redirect path, and returns the first
  redirect's query. It gives up after five minutes. The CLI shows the URL on
  the console; `clanka acp` logs it as a warning, since stdout carries ACP.
- `AntigravityAuth` defaults to the Antigravity CLI's Google OAuth client
  (`1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`),
  and allows overriding it via `CLANKA_ANTIGRAVITY_CLIENT_ID` and
  `CLANKA_ANTIGRAVITY_CLIENT_SECRET` through the `ConfigProvider` of its
  layer.
- `AntigravityAuth` uses that client, the app's scopes and
  the redirect `http://localhost:51121/oauth-callback`, with `access_type=offline`,
  `prompt=consent` and a random `state` it checks.
- After the code exchange it calls `loadCodeAssist`. The project is the
  first of `cloudaicompanionProject`, `projectId` and `project` that is
  set, as an id or `{ id }`; `onboardUser` responses are read the same
  way. Without one it calls `onboardUser` on the default allowed
  tier (else the current tier, else `free-tier`), up to five times two
  seconds apart, until `done`.
- The token and project are stored under `antigravity.auth/token` in the
  `KeyValueStore`. `get` refreshes a token that expires within a minute and
  keeps the project. Only an `invalid_grant` answer clears the token and
  signs in again; any other refresh failure fails `get` and keeps the token
  for the next attempt.

## Requests

- `POST {API}:streamGenerateContent?alt=sse` with the bearer token, the
  Antigravity user agent and
  `{ project, model, userAgent: "antigravity", requestType: "agent", requestId, request }`.
  `request.sessionId` is fixed per client.
- Leading system messages become `systemInstruction`; later ones are user
  text. Roles map to `user` / `model`, and consecutive turns of one role are
  merged.
- Tool calls are `functionCall` parts with their thought signature. For a
  non-Claude model, when the first tool call of a model turn has none, it
  gets `skip_thought_signature_validator`; later parallel calls stay
  unsigned.
- For a Claude model, only reasoning parts with non-blank text carry a
  signature. Text and tool calls are sent unsigned and get no sentinel, as
  CLIProxyAPI's Claude signature sanitizer sends them. Tool results are
  `functionResponse` parts whose `response.result` is always a string.
- Signatures come back as `metadata.antigravity` `{ thoughtSignature, model }`
  on reasoning, text and tool-call parts. They are replayed only to a model
  of the same family (`claude`, `gpt` or `gemini` in the id), and
  reasoning parts only with a replayable signature.
- Tool schemas are reduced to Gemini's subset: `$ref`s inlined, type
  arrays with `null` turned into `nullable`, non-string enums and every
  other keyword dropped.
- `toolChoice` maps to `functionCallingConfig` (`auto` is `VALIDATED`
  for Claude models).

## Thinking

| effort            | Claude 4.x                                             | others                                       |
| ----------------- | ------------------------------------------------------ | -------------------------------------------- |
| absent            | `includeThoughts` only                                 | `includeThoughts` only                       |
| `none` or `null`  | no thinking                                            | no thinking                                  |
| `minimal` … `max` | `thinkingBudget` 1024 … 63999, `maxOutputTokens` 64000 | `thinkingLevel`, `xhigh` and `max` as `high` |

`MaxOutputTokens` sets `maxOutputTokens` on Claude requests and caps a
Claude budget at half of it. Other models get no `maxOutputTokens`, as
CLIProxyAPI strips it for them. The model's `SummarizerTransform` sets it to
`Compaction.summarizerMaxOutputTokens`, so only Claude compaction summaries
are capped.

## Responses

- The body is read line by line: `data:` prefixes are dropped and lines
  are joined until they parse as JSON, so a last event without a closing
  blank line still counts and bare multi-line JSON is read too. A stream that
  ends mid-document is an `InvalidOutputError`.
- A payload with a top-level `error` fails the stream with
  `AiError.reasonFromHttpStatus` of its `code` (502 when the code is not an
  HTTP error status), so a trailing 503 is a retryable `InternalProviderError`.
- Other payloads decode as `{ response: { candidates, usageMetadata, responseId, modelVersion } }`.
- Finish reasons: `STOP` or no finish reason is `tool-calls` after a tool
  call; otherwise `STOP` is `stop` and no finish reason `unknown`; `MAX_TOKENS` is `length`; safety reasons are
  `content-filter`; `MALFORMED_FUNCTION_CALL` is `error`.
- Usage: `promptTokenCount` (with `cachedContentTokenCount` as cache reads),
  `candidatesTokenCount` as text and `thoughtsTokenCount` as reasoning.
- A non-200 status maps through `AiError.reasonFromHttpStatus`, so 429 is a
  retryable `RateLimitError`.

## Catalog and CLI

- `ModelsRepo.antigravity` is a built-in list of the Antigravity models,
  since models.dev does not list them. Every catalog ends with it, cached
  ones included, and `fallback` contains it.
- `--provider antigravity` and `antigravity/<model>[/<effort>]` in
  `clanka acp` use it through `ModelLayer`.

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
- The Antigravity app's OAuth client is not in the source, since GitHub push
  protection rejects it. `AntigravityAuth` reads it from
  `CLANKA_ANTIGRAVITY_CLIENT_ID` and `CLANKA_ANTIGRAVITY_CLIENT_SECRET`
  through the `ConfigProvider` of its layer, when it first needs it; without
  them sign-in fails with an error naming both variables.
- `AntigravityAuth` uses that client, the app's scopes and
  the redirect `http://localhost:51121/oauth-callback`, with `access_type=offline`,
  `prompt=consent` and a random `state` it checks.
- After the code exchange it calls `loadCodeAssist`. Without a
  `cloudaicompanionProject` it calls `onboardUser` on the default allowed
  tier (else the current tier, else `free-tier`), up to five times two
  seconds apart, until `done`.
- The token and project are stored under `antigravity.auth/token` in the
  `KeyValueStore`. `get` refreshes a token that expires within a minute and
  keeps the project; a failed refresh clears the token and signs in again.

## Requests

- `POST {API}:streamGenerateContent?alt=sse` with the bearer token, the
  Antigravity user agent and
  `{ project, model, userAgent: "antigravity", requestType: "agent", requestId, request }`.
  `request.sessionId` is fixed per client.
- Leading system messages become `systemInstruction`; later ones are user
  text. Roles map to `user` / `model`, and consecutive turns of one role are
  merged.
- Tool calls are `functionCall` parts with their thought signature, or
  `skip_thought_signature_validator` when there is none. Tool results are
  `functionResponse` parts whose `response.result` is always a string.
- Reasoning parts are replayed only with their signature. Signatures come
  back as `metadata.antigravity.thoughtSignature` on reasoning, text and
  tool-call parts.
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

`MaxOutputTokens` sets `maxOutputTokens` and caps a Claude budget at half
of it. The model's `SummarizerTransform` sets it to
`Compaction.summarizerMaxOutputTokens`.

## Responses

- SSE events decode as `{ response: { candidates, usageMetadata, responseId, modelVersion } }`.
- Finish reasons: `STOP` is `tool-calls` after a tool call and `stop`
  otherwise; `MAX_TOKENS` is `length`; safety reasons are
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

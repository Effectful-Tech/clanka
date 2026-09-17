# Auto-compaction

Issue: EFF-1391. Status: **implemented**.

Clanka keeps the full `Prompt` for the life of an Agent. Long sessions blow the
context window, overflow retries the same fat prompt, and ACP persists it
unbounded. This spec adds two independent mechanisms to the shared Agent loop
(CLI interactive, `clanka --prompt`, ACP, `delegate` subagents):

1. An always-on cap on `execute` results before they enter the Prompt.
2. Auto-compaction of the live Prompt, before a call (threshold) and after a
   context-length error (overflow).

Out of scope: `/compact`, branch summarization, Pi extension hooks, a model
context-window catalog, truncating `execute` scripts / `applyPatch` bodies,
ACP events for compaction (v1 ignores them).

References (shape only, do not copy wholesale):

- Pi compaction spec: https://pi.dev/docs/latest/compaction
- OpenCode `compaction.ts`:
  https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/compaction.ts

## Module layout

- `src/Compaction.ts` — every pure helper, the config tag, and the two compact
  entry points. `Agent.ts` only calls into it; no summary templates or cut
  logic live in `Agent.ts`.
- `src/AgentOutput.ts` — three new output events: `ExecuteOutputCapped`,
  `CompactionStarted`, `CompactionEnded`.
- `src/OutputFormatter.ts` — one line each for the new events. ACP falls
  through to its `default` branch and ignores them.

## Interfaces (`src/Compaction.ts`)

All signatures are exercised by `src/Compaction.test.ts` and the acceptance
tests in `src/Agent.test.ts`.

The compaction entry points take `CompactionHooks`: `onStart(reason)` fires
once a cut point exists and before the summarizer call (not for no-ops), and
`withSummarizer(effect)` wraps the summarizer call. `AgentModelConfig` gained
`summarizerTransform` for the latter: Codex sets `instructions` to
`summarizerSystem` and `max_output_tokens`; Copilot sets `max_output_tokens`.

### Config

`CompactionConfig` is a `Context.Reference` with defaults:

| field              | default | meaning                                             |
| ------------------ | ------- | --------------------------------------------------- |
| `enabled`          | `true`  | kill switch for both compact paths, **not** the cap |
| `contextWindow`    | 236 000 | assumed window in tokens                            |
| `reserveTokens`    | 16 000  | headroom below the window                           |
| `keepRecentTokens` | 20 000  | tail kept verbatim after a compaction               |

`CompactionConfig.layer(partial)` merges over the defaults. The only runtime
switch is the kill switch: `clanka --no-compaction` / `clanka acp
--no-compaction`, or `CLANKA_COMPACTION=false`. No `settings.json`.

### Constants

- `executeOutputCapChars = 32_000` — the always-on cap.
- `summarizerToolResultCapChars = 2_000` — `execute` dumps in summarizer input.
- `keptToolResultStubChars = 2_000` — stub size when the kept tail still does
  not fit after reasoning is dropped.
- `summarizerMaxOutputTokens = 4_000`.
- `summaryOpenTag` / `summaryCloseTag` — `<compaction-summary>` wrapper.

### Cap

`capOutput(output, maxChars = executeOutputCapChars): CapResult`

- At or under the cap: unchanged, `capped: false`.
- Over: `head + marker + tail`, roughly half the budget each side. Total length
  stays within `maxChars + 1_000`. The marker must contain the original
  character count and the words `startLine` and `endLine` (it tells the model
  to narrow the read with `readFile` start/end or smaller logs).
- `charsBefore` / `charsAfter` feed the `ExecuteOutputCapped` event.

### Tokens

- `estimateTokens(prompt)` — `ceil(JSON.stringify(encodedPrompt).length / 4)`.
  Tests allow ±1 around `length / 4`.
- `estimateMessageTokens(message)` — same measure per message. The sum over a
  prompt's messages must land within 8 tokens of `estimateTokens`.
- `shouldCompact({ prompt, contextTokens, config })` — `false` when disabled;
  otherwise `(contextTokens ?? estimateTokens(prompt)) > contextWindow -
reserveTokens`. The default effective threshold is 220,000 tokens (236,000
  minus the 16,000 reserve). Strictly greater: 220,000 does not fire;
  220,001 does. This applies to both reported usage and the prompt estimate.

### Overflow detection

`isContextLengthError(error: AiError)` returns `true` for:

- `InvalidRequestError` whose description matches the Codex message
  (`exceeds the context window`) or the OpenAI-compatible one
  (`maximum context length is N tokens`), or that carries
  `[code: context_length_exceeded]` / `metadata.openai.errorCode ===
"context_length_exceeded"`.
- `UnknownError` from a 413 with `prompt token count ... exceeds the limit`.

It returns `false` for any other `InvalidRequestError`, and for every
`InternalProviderError`, `RateLimitError`, `NetworkError`. Suggested regex:
`/context[_ ]?(length|window)|maximum context length|exceeds the limit|too many tokens|prompt is too long/i`
plus the error-code check.

### Cut points

`split(prompt, keepRecentTokens): Option<Split>` with
`Split = { system, previousSummary, toSummarize, kept }`.

1. Peel the system message (`system`).
2. If the first non-system message is a user message whose single text part
   is wrapped in the summary tags, extract its inner text as
   `previousSummary` and drop the message from consideration.
3. Walk back from the newest message accumulating `estimateMessageTokens`.
   Stop at the first boundary where adding the next-older message would exceed
   `keepRecentTokens`.
4. Pair rule: if the kept tail would start with a `tool` message, also keep
   the assistant message that made the call. Never leave a `tool` message at
   the head of `kept`.
5. Minimum: `kept` always contains the newest complete unit (the last
   message, plus its assistant call if the last message is a tool result),
   even when that alone exceeds the budget.
6. Return `None` when `toSummarize` is empty (whole prompt is the tail, empty
   prompt, system-only prompt, or only a previous summary precedes the tail).

`findPreviousSummary(prompt)` is the step-2 lookup on its own.

`trimKept(kept, keepRecentTokens)` shrinks a tail that is still over budget
without touching message count, order, or tool ids:

1. Remove `reasoning` parts from assistant messages, oldest first, until the
   tail fits.
2. If still over, replace `execute` tool-result strings in place, oldest
   first, with `capOutput(result, keptToolResultStubChars).output`.

Returns the same array when it already fits.

### Rewrite

- `summarizerPrompt({ previousSummary, messages })` renders the conversation
  as text inside a user message using an OpenCode-style template. Reasoning
  parts are omitted. `execute` results are capped with
  `capOutput(result, summarizerToolResultCapChars)`. If `previousSummary` is
  `Some`, it is included so the new summary supersedes it. No tool messages,
  no agent system prompt, no tools.
- `wrapSummary(summary)` = `summaryOpenTag + "\n" + summary + "\n" +
summaryCloseTag` (tests only check prefix/suffix and containment).
- `rewrite({ system, summary, kept })` = `[system?, user(wrapSummary(summary)),
...kept]`. The system message object is passed through by reference.

### Compaction

- `compact({ prompt, reason })`: `split` → `None` returns `None`;
  otherwise `summarizerPrompt`, a direct `LanguageModel.streamText` with no
  toolkit and `maxOutputTokens: summarizerMaxOutputTokens` (same session
  model, **not** `Agent.send`, so no semaphore), collect the text, then
  `rewrite` with `trimKept(kept)`. Returns `Some({ reason, prompt,
tokensBefore, tokensAfter })`. Fails with the summarizer's `AiError`.
- `compactIfNeeded({ prompt, contextTokens })`: `shouldCompact` gate, then
  `compact` with reason `threshold`. A summarizer failure is logged and
  swallowed (`None`), so the turn proceeds and the overflow path can catch it.
- `compactAfterOverflow({ prompt })`: `None` when disabled; otherwise
  `compact` with reason `overflow`. Failures propagate.

## Agent loop wiring

In `Agent.ts` `spawn`:

1. **Cap** — in `executeScript`, after `Stream.mkString`, run `capOutput`.
   Emit `ScriptOutput` with the full output (the CLI/ACP display keeps its own
   truncation) and return the capped string from the tool handler so that is
   what `Prompt.fromResponseParts` stores. When `capped`, `maybeSend` an
   `ExecuteOutputCapped { charsBefore, charsAfter }` before `ScriptOutput`.
   This runs regardless of `CompactionConfig.enabled`.
2. **Threshold** — track `lastContextTokens: number | undefined` from the
   `finish` part (`usage.inputTokens.total`). At the top of the loop, before
   `streamText`, call `compactIfNeeded({ prompt: prompt.current,
contextTokens: lastContextTokens })`. On `Some`, `MutableRef.set(prompt,
result.prompt)`, reset `lastContextTokens` to `undefined`, and emit
   `CompactionStarted` / `CompactionEnded` around it.
3. **Overflow** — in the retry predicate, if `isContextLengthError(err)` and
   this turn has not compacted for overflow yet: run `compactAfterOverflow`,
   swap the prompt, emit the events, and retry once. `None` (disabled or
   no-op) or a summarizer failure fails the turn. A second context-length
   error after the retry fails the turn. Other retryable errors keep the
   existing behaviour and never compact.
4. **Codex websocket** — after any rewrite, the incremental
   `ResponseIdTracker` must not send `previousResponseId`. The summary user
   message is a fresh object that was never `markParts`-ed, so
   `prepareUnsafe` already returns `None` and sends the full prompt (covered
   by the "forces a full prompt on Codex websocket sessions" test). For
   safety, also call `ResponseIdTracker.clearUnsafe()` via
   `Effect.serviceOption` when present.
5. Subagents share the loop and get the same behaviour for free.

## Acceptance tests

`src/Compaction.test.ts` (unit): cap, estimates, threshold, overflow
detection, cut points / pairing, `trimKept`, summarizer input, rewrite, and a
`ResponseIdTracker` check.

`src/Agent.test.ts` (acceptance, scripted `LanguageModel`, summarizer call
recognised by `tools.length === 0`):

- 32k cap in history, event emitted, still active with `enabled: false`.
- Threshold compaction: next call is system + summary + kept tail, the oldest
  dump is gone, pairs intact, events with reason `threshold`.
- Estimate path with no usage (ACP load), previous summary folded in and only
  one summary message remains, no-op when the tail is the whole prompt,
  disabled config, threshold summarizer failure is skipped.
- Overflow: compact once and retry (reason `overflow`), second overflow fails
  the turn after exactly three calls, summarizer failure fails the turn,
  kill switch fails without compacting, retryable provider errors retry
  without compacting.

Run: `pnpm test` and `pnpm check`. The `it.live` tests exercise the real
retry backoff, so keep the retry policy's first delay short.

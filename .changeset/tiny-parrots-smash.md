---
"clanka": patch
---

Add a new `DuckDuckGo` Effect service in `src/DuckDuckGo.ts` with a `search(query)` API that calls the DuckDuckGo Instant Answer API and returns normalized `SearchResult` values, plus a typed `DuckDuckGoError`. Also export the module from `src/index.ts`.

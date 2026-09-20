---
"clanka": patch
---

Reduce resident memory by using Node's http client and global WebSocket instead of undici and ws, loading turndown, glob and the output formatter on first use, and emitting a comment-free ASCII-only CLI bundle.

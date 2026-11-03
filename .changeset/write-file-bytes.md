---
"clanka": patch
---

The `writeFile` tool now accepts `Uint8Array` content and writes it to the file as raw bytes, including when called through `executeUnsafe` on the RPC executor.

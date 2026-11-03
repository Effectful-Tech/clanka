---
"clanka": patch
---

`executeUnsafe` on the RPC executor now accepts `undefined` params and params with `undefined` properties, instead of dying with a schema validation error.

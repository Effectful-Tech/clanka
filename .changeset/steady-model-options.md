---
"clanka": patch
---

`clanka acp` returns the session's `configOptions` from `session/set_model`, as `session/set_config_option` already does. ACP clients that read the thought level catalog from that response, instead of waiting for a session update, now see it after switching models.

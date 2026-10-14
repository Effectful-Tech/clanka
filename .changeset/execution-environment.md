---
"clanka": minor
---

Give every agent its own working directory.

Before, `changeDirectory` changed one directory shared by the whole executor. Concurrent sub-agents, and every session served by one `layerRpcServer`, could resolve paths against each other's directory.

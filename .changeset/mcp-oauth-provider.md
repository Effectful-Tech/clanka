---
"clanka": minor
---

`McpServers.layer` takes an optional second argument that picks an OAuth provider for each HTTP server.

The function receives the server's name and HTTP config, and returns an `OAuthClientProvider` from `@modelcontextprotocol/sdk/client/auth.js`, or `undefined`. The provider goes to the SDK transport as `authProvider`, which sends its token as a bearer token and calls it when the server answers 401. If the provider throws, for example from `redirectToAuthorization`, the server is `Failed` with that error, or the tool call fails with it. Static headers are still sent. Servers without a provider work as before.

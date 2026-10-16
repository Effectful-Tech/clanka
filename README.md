# clanka

Make the ai do stuff

## OpenAI API access

The OpenAI provider uses Codex subscription authentication by default. To use an
API key instead, set `OPENAI_API_KEY` or pass `--api-key`:

```sh
export OPENAI_API_KEY="your-api-key"
clanka --provider openai --model gpt-6-astra/medium
```

For a custom endpoint, set `OPENAI_API_URL` or pass `--api-url` with the API base
URL (for example, `https://gateway.example.com/v1`). Flags take precedence over
environment variables. API-key mode uses the HTTP Responses API, so custom
endpoints must support `/responses`. Without a key, the Codex authentication
flow and endpoint remain unchanged. These options do not affect Copilot or xAI.

The ACP server accepts the same options:

```sh
clanka acp --model openai/gpt-6-astra/medium --api-url https://gateway.example.com/v1
```

These options configure the chat model, including subagents. Semantic search
continues to use `OPENAI_API_KEY` and the default OpenAI embeddings endpoint.

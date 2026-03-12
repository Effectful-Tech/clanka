import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import * as WebToMarkdown from "./WebToMarkdown.ts"

describe("WebToMarkdown", () => {
  it.effect("convertUrl follows redirects", () =>
    Effect.gen(function* () {
      const requests = yield* Ref.make<Array<string>>([])
      const client = HttpClient.make(
        (request: HttpClientRequest.HttpClientRequest) =>
          Effect.gen(function* () {
            yield* Ref.update(requests, (current) => [...current, request.url])

            if (request.url === "https://example.com/start") {
              return HttpClientResponse.fromWeb(
                request,
                new Response(null, {
                  status: 302,
                  headers: { location: "/article" },
                }),
              )
            }

            if (request.url === "https://example.com/article") {
              return HttpClientResponse.fromWeb(
                request,
                new Response("<main><h1>Hello</h1><p>World</p></main>", {
                  status: 200,
                  headers: { "content-type": "text/html" },
                }),
              )
            }

            return HttpClientResponse.fromWeb(
              request,
              new Response("not found", { status: 404 }),
            )
          }),
      )

      const { markdown, seen } = yield* Effect.gen(function* () {
        const webToMarkdown = yield* WebToMarkdown.WebToMarkdown
        const markdown = yield* webToMarkdown.convertUrl(
          "https://example.com/start",
        )
        const seen = yield* Ref.get(requests)
        return { markdown, seen }
      }).pipe(
        Effect.provide(WebToMarkdown.layer),
        Effect.provideService(HttpClient.HttpClient, client),
      )

      assert.deepStrictEqual(seen, [
        "https://example.com/start",
        "https://example.com/article",
      ])
      assert.strictEqual(markdown.trim(), "Hello\n=====\n\nWorld")
    }),
  )
})

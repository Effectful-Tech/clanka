import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { DuckDuckGo } from "./DuckDuckGo.ts"

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  })

const makeClient = Effect.fn("makeClient")(function* (
  handler: (
    request: HttpClientRequest.HttpClientRequest,
    attempt: number,
  ) => Response,
) {
  const attempts = yield* Ref.make(0)
  const requests = yield* Ref.make<Array<HttpClientRequest.HttpClientRequest>>(
    [],
  )
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1)
      yield* Ref.update(requests, (current) => [...current, request])
      return HttpClientResponse.fromWeb(request, handler(request, attempt))
    }),
  )

  return {
    attempts,
    client,
    requests,
  } as const
})

describe("DuckDuckGo", () => {
  it.effect("returns an empty array for blank queries", () =>
    Effect.gen(function* () {
      const { attempts, client } = yield* makeClient(
        () => new Response(null, { status: 500 }),
      )
      const duckDuckGo = yield* DuckDuckGo.make.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      )

      const results = yield* duckDuckGo.search("   ")

      assert.deepStrictEqual(results, [])
      assert.strictEqual(yield* Ref.get(attempts), 0)
    }),
  )

  it.effect("normalizes abstract and related topic results", () =>
    Effect.gen(function* () {
      const { client, requests } = yield* makeClient(() =>
        jsonResponse({
          Heading: "Effect",
          AbstractText: "Typed functional programming for TypeScript",
          AbstractURL: "https://effect.website",
          Results: [
            {
              Text: "Effect docs - Official documentation",
              FirstURL: "https://effect.website/docs",
            },
          ],
          RelatedTopics: [
            {
              Name: "Guides",
              Topics: [
                {
                  Text: "Effect docs - Duplicate entry",
                  FirstURL: "https://effect.website/docs",
                },
                {
                  Text: "GitHub - Effect repository",
                  FirstURL: "https://github.com/Effect-TS/effect",
                },
              ],
            },
            {
              Text: "No separator text",
              FirstURL: "https://example.com/no-separator",
            },
          ],
        }),
      )
      const duckDuckGo = yield* DuckDuckGo.make.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      )

      const results = yield* duckDuckGo.search("effect")
      const seenRequests = yield* Ref.get(requests)

      assert.strictEqual(seenRequests.length, 1)
      assert.strictEqual(seenRequests[0]?.url, "https://api.duckduckgo.com/")
      assert.deepStrictEqual(seenRequests[0]?.urlParams.toJSON(), {
        _id: "UrlParams",
        params: {
          q: "effect",
          format: "json",
          no_html: "1",
          no_redirect: "1",
          skip_disambig: "1",
        },
      })
      assert.deepStrictEqual(
        results.map((result) => ({
          title: result.title,
          url: result.url,
          description: result.description,
        })),
        [
          {
            title: "Effect",
            url: "https://effect.website",
            description: "Typed functional programming for TypeScript",
          },
          {
            title: "Effect docs",
            url: "https://effect.website/docs",
            description: "Official documentation",
          },
          {
            title: "GitHub",
            url: "https://github.com/Effect-TS/effect",
            description: "Effect repository",
          },
          {
            title: "No separator text",
            url: "https://example.com/no-separator",
            description: "No separator text",
          },
        ],
      )
    }),
  )

  it.effect("maps non-2xx responses to RequestFailed errors", () =>
    Effect.gen(function* () {
      const { client } = yield* makeClient(
        () => new Response("boom", { status: 500 }),
      )
      const duckDuckGo = yield* DuckDuckGo.make.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      )

      const error = yield* duckDuckGo.search("effect").pipe(Effect.flip)

      assert.strictEqual(error._tag, "DuckDuckGoError")
      assert.strictEqual(error.reason, "RequestFailed")
    }),
  )

  it.effect("maps invalid payloads to DecodeFailed errors", () =>
    Effect.gen(function* () {
      const { client } = yield* makeClient(
        () =>
          new Response("{ not json", {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }),
      )
      const duckDuckGo = yield* DuckDuckGo.make.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      )

      const error = yield* duckDuckGo.search("effect").pipe(Effect.flip)

      assert.strictEqual(error._tag, "DuckDuckGoError")
      assert.strictEqual(error.reason, "DecodeFailed")
    }),
  )
})

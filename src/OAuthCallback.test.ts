import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { OAuthCallback, layerLoopback } from "./OAuthCallback.ts"

describe("OAuthCallback.layerLoopback", () => {
  it.live("shows the URL and returns the query of the redirect", () =>
    Effect.gen(function* () {
      const redirectUri = "http://localhost:51987/oauth-callback"
      const statuses: Array<number> = []
      // The browser requests a favicon before the user signs in.
      const browse = (path: string) =>
        Effect.promise(() => fetch(`http://localhost:51987${path}`)).pipe(
          Effect.map((response) => statuses.push(response.status)),
        )
      const shown: Array<string> = []
      const params = yield* OAuthCallback.use((callback) =>
        callback.receive({ url: "https://accounts.test/auth", redirectUri }),
      ).pipe(
        Effect.provide(
          layerLoopback((url) =>
            Effect.sync(() => shown.push(url)).pipe(
              Effect.andThen(browse("/favicon.ico")),
              Effect.andThen(browse("/oauth-callback?code=abc&state=xyz")),
            ),
          ),
        ),
      )
      assert.deepStrictEqual(shown, ["https://accounts.test/auth"])
      assert.deepStrictEqual(statuses, [404, 200])
      assert.deepStrictEqual(Object.fromEntries(params), {
        code: "abc",
        state: "xyz",
      })
    }),
  )
})

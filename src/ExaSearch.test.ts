import { assert, describe, it } from "@effect/vitest"
import { Client } from "@modelcontextprotocol/sdk/client"
import * as Effect from "effect/Effect"
import { afterAll, afterEach, beforeEach, vi } from "vitest"
import * as ExaSearch from "./ExaSearch.ts"

describe("ExaSearch lazy connection", () => {
  const connect = vi.spyOn(Client.prototype, "connect")
  const callTool = vi.spyOn(Client.prototype, "callTool")
  const close = vi.spyOn(Client.prototype, "close")

  beforeEach(() => {
    connect.mockResolvedValue(undefined)
    callTool.mockResolvedValue({
      content: [{ type: "text", text: "Search results" }],
    })
    close.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  afterAll(() => {
    vi.restoreAllMocks()
  })

  it.effect("does not connect when the layer is built without a search", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* ExaSearch.ExaSearch
        assert.strictEqual(connect.mock.calls.length, 0)
        assert.strictEqual(callTool.mock.calls.length, 0)
      }).pipe(Effect.provide(ExaSearch.layer))

      assert.strictEqual(connect.mock.calls.length, 0)
    }),
  )

  it.effect("connects on the first search before calling the tool", () =>
    Effect.gen(function* () {
      const events: Array<string> = []
      connect.mockImplementation(async () => {
        events.push("connect")
        await Promise.resolve()
        events.push("connected")
      })
      callTool.mockImplementation(async () => {
        events.push("toolCall")
        return { content: [{ type: "text", text: "Search results" }] }
      })

      yield* Effect.gen(function* () {
        const exa = yield* ExaSearch.ExaSearch
        events.push("search")
        const result = yield* exa.search({ query: "Effect" })

        assert.strictEqual(result, "Search results")
        assert.deepStrictEqual(events, [
          "search",
          "connect",
          "connected",
          "toolCall",
        ])
        assert.strictEqual(connect.mock.calls.length, 1)
        assert.deepStrictEqual(callTool.mock.calls[0]?.[0], {
          name: "web_search_exa",
          arguments: { query: "Effect", num_results: 3 },
        })
      }).pipe(Effect.provide(ExaSearch.layer))
    }),
  )

  it.effect("reuses the connection for subsequent searches", () =>
    Effect.gen(function* () {
      const exa = yield* ExaSearch.ExaSearch

      assert.strictEqual(
        yield* exa.search({ query: "first" }),
        "Search results",
      )
      assert.strictEqual(connect.mock.calls.length, 1)
      assert.strictEqual(close.mock.calls.length, 0)

      assert.strictEqual(
        yield* exa.search({ query: "second", numResults: 5 }),
        "Search results",
      )
      assert.strictEqual(connect.mock.calls.length, 1)
      assert.strictEqual(close.mock.calls.length, 0)
      assert.strictEqual(callTool.mock.calls.length, 2)
      assert.deepStrictEqual(callTool.mock.calls[1]?.[0], {
        name: "web_search_exa",
        arguments: { query: "second", num_results: 5 },
      })
    }).pipe(Effect.provide(ExaSearch.layer)),
  )
})

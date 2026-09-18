import { assert, describe, it } from "@effect/vitest"
import { Client } from "@modelcontextprotocol/sdk/client"
import * as Effect from "effect/Effect"
import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { afterAll, afterEach, beforeEach, vi } from "vitest"
import * as ExaSearch from "./ExaSearch.ts"
import * as McpClient from "./McpClient.ts"

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
    vi.resetAllMocks()
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
      assert.strictEqual(close.mock.calls.length, 1)
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

  it.effect("shares an in-flight connection between concurrent searches", () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      connect.mockImplementation(() => {
        started.resolve()
        return release.promise
      })
      const exa = yield* ExaSearch.ExaSearch
      const searches = yield* Effect.all(
        [exa.search({ query: "first" }), exa.search({ query: "second" })],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild)
      yield* Effect.promise(() => started.promise)
      yield* Effect.yieldNow
      assert.strictEqual(connect.mock.calls.length, 1)
      assert.strictEqual(callTool.mock.calls.length, 0)
      release.resolve()
      assert.deepStrictEqual(yield* Fiber.join(searches), [
        "Search results",
        "Search results",
      ])
      assert.strictEqual(connect.mock.calls.length, 1)
      assert.strictEqual(callTool.mock.calls.length, 2)
    }).pipe(Effect.provide(ExaSearch.layer)),
  )

  it.effect(
    "maps connection failures to ExaError and closes the failed client",
    () =>
      Effect.gen(function* () {
        const failure = new Error("connection unavailable")
        connect.mockRejectedValueOnce(failure)
        yield* Effect.gen(function* () {
          const exa = yield* ExaSearch.ExaSearch
          const error = yield* Effect.flip(exa.search({ query: "first" }))
          assert.instanceOf(error, ExaSearch.ExaError)
          assert.instanceOf(error.cause, McpClient.McpClientError)
          assert.strictEqual(
            (error.cause as McpClient.McpClientError).cause,
            failure,
          )
          assert.strictEqual(callTool.mock.calls.length, 0)
          assert.strictEqual(close.mock.calls.length, 0)
        }).pipe(Effect.provide(ExaSearch.layer))
        assert.strictEqual(close.mock.calls.length, 1)
      }),
  )

  it.effect(
    "retries after a failed first connection and then reuses success",
    () =>
      Effect.gen(function* () {
        connect.mockRejectedValueOnce(new Error("temporary failure"))
        const exa = yield* ExaSearch.ExaSearch
        yield* Effect.flip(exa.search({ query: "first" }))
        const retry = yield* Effect.exit(exa.search({ query: "retry" }))
        assert.strictEqual(connect.mock.calls.length, 2)
        assert.deepStrictEqual(retry, Exit.succeed("Search results"))
        assert.strictEqual(
          yield* exa.search({ query: "third" }),
          "Search results",
        )
        assert.strictEqual(connect.mock.calls.length, 2)
        assert.strictEqual(callTool.mock.calls.length, 2)
      }).pipe(Effect.provide(ExaSearch.layer)),
  )

  it.effect(
    "retries after interruption instead of cancelling later searches",
    () =>
      Effect.gen(function* () {
        const started = Promise.withResolvers<void>()
        let signal: AbortSignal | undefined
        connect.mockImplementationOnce((_transport, options) => {
          signal = options?.signal
          started.resolve()
          return new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal?.reason), {
              once: true,
            })
          })
        })
        const exa = yield* ExaSearch.ExaSearch
        const first = yield* exa
          .search({ query: "first" })
          .pipe(Effect.forkChild)
        yield* Effect.promise(() => started.promise)
        yield* Fiber.interrupt(first)
        const interrupted = yield* Fiber.await(first)
        assert.isTrue(
          Exit.isFailure(interrupted) &&
            Cause.hasInterruptsOnly(interrupted.cause),
        )
        assert.isTrue(signal?.aborted)
        assert.strictEqual(callTool.mock.calls.length, 0)
        const retry = yield* Effect.exit(exa.search({ query: "retry" }))
        assert.strictEqual(connect.mock.calls.length, 2)
        assert.deepStrictEqual(retry, Exit.succeed("Search results"))
        assert.strictEqual(
          yield* exa.search({ query: "third" }),
          "Search results",
        )
        assert.strictEqual(connect.mock.calls.length, 2)
      }).pipe(Effect.provide(ExaSearch.layer)),
  )

  it.effect("closes the connected client once when its scope ends", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const exa = yield* ExaSearch.ExaSearch
        yield* exa.search({ query: "first" })
        yield* exa.search({ query: "second" })
        assert.strictEqual(close.mock.calls.length, 0)
      }).pipe(Effect.provide(ExaSearch.layer))
      assert.strictEqual(close.mock.calls.length, 1)
      assert.strictEqual(close.mock.instances[0], connect.mock.instances[0])
    }),
  )
})

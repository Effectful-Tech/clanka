import { assert, describe, it } from "@effect/vitest"
import { Client } from "@modelcontextprotocol/sdk/client"
import * as Effect from "effect/Effect"
import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
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
    vi.resetAllMocks()
  })

  afterAll(() => {
    vi.restoreAllMocks()
  })

  it.effect("connects lazily and reuses the connection", () =>
    Effect.gen(function* () {
      const exa = yield* ExaSearch.ExaSearch
      assert.strictEqual(connect.mock.calls.length, 0)

      assert.strictEqual(
        yield* exa.search({ query: "first" }),
        "Search results",
      )
      assert.strictEqual(
        yield* exa.search({ query: "second" }),
        "Search results",
      )
      assert.strictEqual(connect.mock.calls.length, 1)
      assert.strictEqual(callTool.mock.calls.length, 2)
    }).pipe(Effect.provide(ExaSearch.layer)),
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
})

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { beforeEach, expect, it, vi } from "vitest"
import * as ExaSearch from "./ExaSearch.ts"

const sdk = vi.hoisted(() => ({
  loading: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
  pauseLoad: false,
  clients: 0,
  connect: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
  callTool: vi.fn(),
}))

vi.mock("@modelcontextprotocol/sdk/client", async () => {
  sdk.loading.resolve()
  if (sdk.pauseLoad) await sdk.release.promise
  return {
    Client: class {
      constructor() {
        sdk.clients++
      }
      connect = sdk.connect
      close = sdk.close
      callTool = sdk.callTool
    },
  }
})
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    readonly url: URL
    constructor(url: URL) {
      this.url = url
    }
  },
}))

beforeEach(() => {
  vi.resetAllMocks()
  sdk.clients = 0
  sdk.connect.mockResolvedValue(undefined)
  sdk.close.mockResolvedValue(undefined)
  sdk.callTool.mockResolvedValue({
    content: [{ type: "text", text: "Search results" }],
  })
})

it("recovers from interrupted initialization and cleans up the reused client", async () => {
  sdk.pauseLoad = true
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const exa = yield* ExaSearch.ExaSearch
        const first = yield* Effect.forkChild(
          exa.search({ query: "cancelled" }),
        )
        yield* Effect.promise(() => sdk.loading.promise)
        yield* Fiber.interrupt(first)
        expect(Exit.hasInterrupts(yield* Fiber.await(first))).toBe(true)
        sdk.release.resolve()

        expect(yield* exa.search({ query: "recovered" })).toBe("Search results")
        expect(yield* exa.search({ query: "reused" })).toBe("Search results")
        expect(sdk.clients).toBe(1)
        expect(sdk.connect).toHaveBeenCalledTimes(1)
        expect(sdk.callTool).toHaveBeenCalledTimes(2)
        expect(sdk.close).not.toHaveBeenCalled()
      }).pipe(Effect.provide(ExaSearch.layer)),
    )
    expect(sdk.close).toHaveBeenCalledTimes(1)
  } finally {
    sdk.release.resolve()
    sdk.pauseLoad = false
  }
})

it("reuses one client across connection failure and concurrent searches until scope exit", async () => {
  const connecting = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  sdk.connect.mockRejectedValueOnce(new Error("temporary failure"))
  sdk.connect.mockImplementationOnce(() => {
    connecting.resolve()
    return release.promise
  })

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const exa = yield* ExaSearch.ExaSearch
        expect((yield* Effect.flip(exa.search({ query: "fails" })))._tag).toBe(
          "ExaError",
        )
        const first = yield* Effect.forkChild(exa.search({ query: "first" }))
        yield* Effect.promise(() => connecting.promise)
        const second = yield* Effect.forkChild(
          exa.search({ query: "second" }),
          {
            startImmediately: true,
          },
        )
        release.resolve()
        expect(yield* Fiber.joinAll([first, second])).toEqual([
          "Search results",
          "Search results",
        ])
        expect(yield* exa.search({ query: "later" })).toBe("Search results")
        expect(sdk.clients).toBe(1)
        expect(sdk.connect).toHaveBeenCalledTimes(2)
        expect(sdk.callTool).toHaveBeenCalledTimes(3)
        expect(sdk.close).not.toHaveBeenCalled()
      }).pipe(Effect.provide(ExaSearch.layer)),
    )
    expect(sdk.close).toHaveBeenCalledTimes(1)
  } finally {
    release.resolve()
  }
})

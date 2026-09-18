import { assert, describe, it } from "@effect/vitest"
import { Client } from "@modelcontextprotocol/sdk/client"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { expect, vi } from "vitest"

// Exercise the real SDK handshake and cleanup, replacing only HTTP I/O.
const makeTransport = (fetch: typeof globalThis.fetch) =>
  new StreamableHTTPClientTransport(new URL("https://exa.invalid/mcp"), {
    fetch,
  }) as Transport

const successfulFetch = () =>
  vi.fn<typeof globalThis.fetch>(async (_input, init) => {
    if (init?.method === "GET") return new Response(null, { status: 405 })
    const request = JSON.parse(String(init?.body))
    if (request.method === "notifications/initialized")
      return new Response(null, { status: 202 })
    assert.strictEqual(request.method, "initialize")
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params.protocolVersion,
        capabilities: {},
        serverInfo: { name: "test-exa", version: "1.0.0" },
      },
    })
  })

describe("MCP SDK HTTP transport reset", () => {
  it("clears the transport after initialize fails so the same client can retry", async () => {
    const client = new Client({ name: "test", version: "1.0.0" })
    const failure = new Error("network unavailable")
    const failedFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(failure)
    try {
      await expect(client.connect(makeTransport(failedFetch))).rejects.toThrow(
        "network unavailable",
      )
      assert.strictEqual(failedFetch.mock.calls.length, 1)
      assert.isUndefined(client.transport)
      const fetch = successfulFetch()
      const transport = makeTransport(fetch)
      await client.connect(transport)
      assert.strictEqual(client.transport, transport)
      assert.strictEqual(client.getServerVersion()?.name, "test-exa")
    } finally {
      await client.close()
    }
    assert.isUndefined(client.transport)
  })

  it("clears the transport after initialize is aborted so the same client can retry", async () => {
    const client = new Client({ name: "test", version: "1.0.0" })
    const started = Promise.withResolvers<void>()
    const controller = new AbortController()
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      started.resolve()
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        )
      })
    })
    try {
      const connecting = client.connect(makeTransport(fetch), {
        signal: controller.signal,
      })
      const rejected = expect(connecting).rejects.toThrow("cancelled search")
      await started.promise
      controller.abort(new Error("cancelled search"))
      await rejected
      assert.isUndefined(client.transport)
      const transport = makeTransport(successfulFetch())
      await client.connect(transport)
      assert.strictEqual(client.transport, transport)
    } finally {
      await client.close()
    }
  })

  it("requires explicit close if transport.start fails before initialize", async () => {
    const client = new Client({ name: "test", version: "1.0.0" })
    const fetch = successfulFetch()
    const transport = makeTransport(fetch)
    const start = vi
      .spyOn(transport, "start")
      .mockRejectedValueOnce(new Error("start failed"))
    try {
      await expect(client.connect(transport)).rejects.toThrow("start failed")
      assert.strictEqual(fetch.mock.calls.length, 0)
      assert.strictEqual(client.transport, transport)
      await expect(client.connect(makeTransport(fetch))).rejects.toThrow(
        "Already connected to a transport",
      )
      await client.close()
      assert.isUndefined(client.transport)
      await client.connect(makeTransport(fetch))
      assert.strictEqual(client.getServerVersion()?.name, "test-exa")
    } finally {
      start.mockRestore()
      await client.close()
    }
  })
})

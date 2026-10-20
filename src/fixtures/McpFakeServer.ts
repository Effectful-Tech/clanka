import * as Http from "node:http"
import type { AddressInfo } from "node:net"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"

/**
 * A tool offered by the fake server. The schemas are raw JSON Schema, sent as
 * they are in `tools/list`.
 */
export interface FakeTool {
  readonly name: string
  readonly description?: string | undefined
  readonly inputSchema?: Tool["inputSchema"] | undefined
  readonly outputSchema?: Tool["outputSchema"] | undefined
  readonly call?:
    | ((
        args: Record<string, unknown>,
        context: {
          readonly signal: AbortSignal
          readonly close: () => Promise<void>
          /** Ends a resumable HTTP response stream before the result. */
          readonly closeStream: () => void
        },
      ) => CallToolResult | Promise<CallToolResult>)
    | undefined
}

export const text = (value: string): CallToolResult => ({
  content: [{ type: "text", text: value }],
})

/**
 * A low-level SDK server, so `tools/list` can page and tools can carry any
 * JSON Schema. `pageSize` defaults to every tool on one page.
 */
export const makeFakeServer = (options: {
  readonly tools: ReadonlyArray<FakeTool>
  readonly pageSize?: number | undefined
  readonly instructions?: string | undefined
}): Server => {
  const server = new Server(
    { name: "fake", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      ...(options.instructions !== undefined
        ? { instructions: options.instructions }
        : {}),
    },
  )
  const pageSize = options.pageSize ?? options.tools.length
  server.setRequestHandler(ListToolsRequestSchema, (request) => {
    const start = Number(request.params?.cursor ?? 0)
    const end = start + pageSize
    return {
      tools: options.tools.slice(start, end).map((tool) => {
        const listed: Tool = {
          name: tool.name,
          inputSchema: tool.inputSchema ?? { type: "object" },
        }
        if (tool.description !== undefined) {
          listed.description = tool.description
        }
        if (tool.outputSchema !== undefined) {
          listed.outputSchema = tool.outputSchema
        }
        return listed
      }),
      ...(end < options.tools.length ? { nextCursor: String(end) } : {}),
    }
  })
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const tool = options.tools.find((tool) => tool.name === request.params.name)
    if (tool?.call === undefined) {
      throw new Error(`unknown tool ${request.params.name}`)
    }
    return tool.call(request.params.arguments ?? {}, {
      signal: extra.signal,
      close: () => server.close(),
      closeStream: () => extra.closeSSEStream?.(),
    })
  })
  return server
}

/**
 * Serves one fake server session over streamable HTTP on a loopback port.
 *
 * - `authorization` collects the header of every request.
 * - `resumable` stores events, so a closed response stream can be resumed.
 * - `endSession` answers every later request with 404, as a server does for
 *   a session it has ended. `afterEnd` lists those requests as
 *   `"<HTTP method> <JSON-RPC method>"`.
 */
export const listenHttp = async (
  server: Server,
  path = "/mcp",
  options: { readonly resumable?: boolean } = {},
): Promise<{
  readonly url: string
  readonly authorization: ReadonlyArray<string | undefined>
  readonly afterEnd: ReadonlyArray<string>
  readonly endSession: () => void
  readonly close: () => Promise<void>
}> => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    ...(options.resumable === true
      ? { eventStore: new InMemoryEventStore(), retryInterval: 10 }
      : {}),
  })
  // The SDK's optional callbacks predate `exactOptionalPropertyTypes`.
  await server.connect(transport as Transport)
  const authorization: Array<string | undefined> = []
  const afterEnd: Array<string> = []
  let ended = false
  const http = Http.createServer((request, response) => {
    authorization.push(request.headers.authorization)
    if (!ended) {
      void transport.handleRequest(request, response)
      return
    }
    let body = ""
    request.on("data", (chunk) => {
      body += String(chunk)
    })
    request.on("end", () => {
      const method = body === "" ? undefined : JSON.parse(body).method
      afterEnd.push(`${request.method} ${method ?? ""}`.trim())
      response.writeHead(404, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32001, message: "Session not found" },
        }),
      )
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const { port } = http.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}${path}`,
    authorization,
    afterEnd,
    endSession: () => {
      ended = true
    },
    close: async () => {
      http.closeAllConnections()
      await new Promise((resolve) => http.close(resolve))
      await server.close()
    },
  }
}

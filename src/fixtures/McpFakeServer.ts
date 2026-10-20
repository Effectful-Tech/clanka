import * as Http from "node:http"
import type { AddressInfo } from "node:net"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
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
    })
  })
  return server
}

/**
 * Serves one fake server session over streamable HTTP on a loopback port.
 * `authorization` collects the header of every request.
 */
export const listenHttp = async (
  server: Server,
  path = "/mcp",
): Promise<{
  readonly url: string
  readonly authorization: ReadonlyArray<string | undefined>
  readonly close: () => Promise<void>
}> => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  })
  // The SDK's optional callbacks predate `exactOptionalPropertyTypes`.
  await server.connect(transport as Transport)
  const authorization: Array<string | undefined> = []
  const http = Http.createServer((request, response) => {
    authorization.push(request.headers.authorization)
    void transport.handleRequest(request, response)
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const { port } = http.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}${path}`,
    authorization,
    close: async () => {
      http.closeAllConnections()
      await new Promise((resolve) => http.close(resolve))
      await server.close()
    },
  }
}

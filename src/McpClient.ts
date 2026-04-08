/**
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Context from "effect/Context"
import { Client } from "@modelcontextprotocol/sdk/client"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"

/**
 * @since 1.0.0
 * @category Services
 */
export class McpClient extends Context.Service<
  McpClient,
  {
    connect(options: {
      readonly url: string
    }): Effect.Effect<void, McpClientError>
    toolCall(options: {
      readonly name: string
      readonly arguments: Record<string, unknown>
    }): Effect.Effect<unknown, McpClientError>
  }
>()("clanka/McpClient") {}

/**
 * @since 1.0.0
 * @category Errors
 */
export class McpClientError extends Schema.TaggedErrorClass<McpClientError>()(
  "McpClientError",
  {
    cause: Schema.Defect,
  },
) {}

/**
 * @since 1.0.0
 * @category Layers
 */
export const layer = Layer.effect(
  McpClient,
  Effect.gen(function* () {
    const client = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Client({
            name: "clanka",
            version: "0.1.0",
          }),
      ),
      (client) => Effect.promise(() => client.close()),
    )

    const connect = Effect.fn("McpClient.connect")(function* (options: {
      readonly url: string
    }) {
      const transport = new StreamableHTTPClientTransport(new URL(options.url))
      return yield* Effect.tryPromise({
        try: (signal) => client.connect(transport as Transport, { signal }),
        catch: (cause) => new McpClientError({ cause }),
      })
    })

    return McpClient.of({
      connect,
      toolCall: Effect.fn("McpClient.toolCall")((options) =>
        Effect.tryPromise({
          try: async () => {
            const response = await client.callTool({
              name: options.name,
              arguments: options.arguments,
            })
            return response.structuredContent ?? response.content
          },
          catch: (cause) => new McpClientError({ cause }),
        }),
      ),
    })
  }),
)

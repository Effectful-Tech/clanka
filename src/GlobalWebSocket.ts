/**
 * @since 1.0.0
 */
import * as Layer from "effect/Layer"
import * as Socket from "effect/unstable/socket/Socket"

type GlobalWebSocket = InstanceType<typeof globalThis.WebSocket>

// Node and Bun accept an options object with handshake headers, which the
// standard lib typings do not declare. The global is read lazily because
// touching it loads Node's WebSocket implementation.
const webSocketWithOptions = () =>
  globalThis.WebSocket as unknown as new (
    url: string,
    options?:
      | string
      | Array<string>
      | { readonly headers?: Readonly<Record<string, string>> | undefined },
  ) => GlobalWebSocket

/**
 * Provides a `Socket.WebSocketConstructor` backed by the global `WebSocket`
 * class, forwarding handshake headers through the non-standard `headers`
 * option supported by Node and Bun. This avoids loading the `ws` package.
 *
 * @since 1.0.0
 * @category Layers
 */
export const layerWebSocketConstructor = Layer.succeed(
  Socket.WebSocketConstructor,
)((url, options) => {
  if (
    options === undefined ||
    typeof options === "string" ||
    Array.isArray(options)
  ) {
    return new (webSocketWithOptions())(url, options)
  }
  return new (webSocketWithOptions())(url, { headers: options.headers })
})

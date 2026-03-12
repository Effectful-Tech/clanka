/**
 * @since 1.0.0
 */
import { Effect, Layer, ServiceMap } from "effect"
import { HttpClient, HttpClientError } from "effect/unstable/http"
import TurndownService from "turndown"

/**
 * @since 1.0.0
 * @category Services
 */
export class WebToMarkdown extends ServiceMap.Service<
  WebToMarkdown,
  {
    convertHtml(html: string): Effect.Effect<string>
    convertUrl(
      url: string,
    ): Effect.Effect<string, HttpClientError.HttpClientError>
  }
>()("clanka/WebToMarkdown") {}

/**
 * @since 1.0.0
 * @category Layers
 */
export const layer = Layer.effect(
  WebToMarkdown,
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.followRedirects(),
      HttpClient.filterStatusOk,
      HttpClient.retryTransient({
        times: 3,
      }),
    )

    const toRemove = new Set([
      "head",
      "footer",
      "header",
      "script",
      "style",
      "meta",
      "link",
      "noscript",
      "iframe",
      "object",
      "embed",
      "svg",
      "canvas",
      "audio",
      "video",
      "source",
      "track",
      "map",
      "area",
      "base",
      "form",
      "input",
      "textarea",
      "button",
      "select",
      "option",
      "optgroup",
      "datalist",
      "keygen",
      "output",
      "progress",
      "meter",
    ])
    const turndown = new TurndownService().remove((node) =>
      toRemove.has(node.nodeName.toLowerCase()),
    )

    const convertHtml = Effect.fn("WebToMarkdown.convertHtml")((html) =>
      Effect.sync(() => turndown.turndown(html)),
    )

    return WebToMarkdown.of({
      convertHtml,
      convertUrl: Effect.fn("WebToMarkdown.convertUrl")(function* (url) {
        const response = yield* client.get(url)
        const html = yield* response.text
        return turndown.turndown(html)
      }),
    })
  }),
)

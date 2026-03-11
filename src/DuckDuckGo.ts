/**
 * @since 1.0.0
 */
import { Effect, flow, Layer, Schema, ServiceMap } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"

export const API_URL = "https://api.duckduckgo.com"

const DuckDuckGoSearchResponseSchema = Schema.Struct({
  Heading: Schema.optional(Schema.String),
  AbstractText: Schema.optional(Schema.String),
  AbstractURL: Schema.optional(Schema.String),
  Results: Schema.optional(Schema.Array(Schema.Unknown)),
  RelatedTopics: Schema.optional(Schema.Array(Schema.Unknown)),
})

type DuckDuckGoSearchResponse = typeof DuckDuckGoSearchResponseSchema.Type

export class SearchResult extends Schema.Class<SearchResult>(
  "clanka/DuckDuckGo/SearchResult",
)({
  title: Schema.String,
  url: Schema.String,
  description: Schema.String,
}) {}

export class DuckDuckGoError extends Schema.TaggedErrorClass<DuckDuckGoError>()(
  "DuckDuckGoError",
  {
    reason: Schema.Literals(["RequestFailed", "DecodeFailed"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

const requestFailed = (message: string, cause?: unknown) =>
  new DuckDuckGoError({
    reason: "RequestFailed",
    message,
    ...(cause === undefined ? {} : { cause }),
  })

const decodeFailed = (message: string, cause?: unknown) =>
  new DuckDuckGoError({
    reason: "DecodeFailed",
    message,
    ...(cause === undefined ? {} : { cause }),
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const getNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined

const splitSearchText = (
  text: string,
): {
  readonly title: string
  readonly description: string
} => {
  const separator = text.indexOf(" - ")
  if (separator === -1) {
    return {
      title: text,
      description: text,
    }
  }

  const title = text.slice(0, separator).trim()
  const description = text.slice(separator + 3).trim()

  return {
    title: title === "" ? text : title,
    description: description === "" ? text : description,
  }
}

const appendResult = (
  result: SearchResult,
  seenUrls: Set<string>,
  results: Array<SearchResult>,
): void => {
  if (seenUrls.has(result.url)) {
    return
  }

  seenUrls.add(result.url)
  results.push(result)
}

const resultFromText = (url: string, text: string): SearchResult => {
  const parsed = splitSearchText(text)
  return new SearchResult({
    title: parsed.title,
    url,
    description: parsed.description,
  })
}

const appendTopicResults = (
  topics: ReadonlyArray<unknown>,
  seenUrls: Set<string>,
  results: Array<SearchResult>,
): void => {
  for (const topic of topics) {
    if (!isRecord(topic)) {
      continue
    }

    const nestedTopics = topic["Topics"]
    if (Array.isArray(nestedTopics)) {
      appendTopicResults(nestedTopics, seenUrls, results)
      continue
    }

    const text = getNonEmptyString(topic["Text"])
    const url = getNonEmptyString(topic["FirstURL"])
    if (text === undefined || url === undefined) {
      continue
    }

    appendResult(resultFromText(url, text), seenUrls, results)
  }
}

const toSearchResults = (
  response: DuckDuckGoSearchResponse,
): Array<SearchResult> => {
  const results = Array<SearchResult>()
  const seenUrls = new Set<string>()

  const abstractUrl = getNonEmptyString(response.AbstractURL)
  if (abstractUrl !== undefined) {
    const title = getNonEmptyString(response.Heading) ?? abstractUrl
    const description = getNonEmptyString(response.AbstractText) ?? title
    appendResult(
      new SearchResult({
        title,
        url: abstractUrl,
        description,
      }),
      seenUrls,
      results,
    )
  }

  if (response.Results !== undefined) {
    appendTopicResults(response.Results, seenUrls, results)
  }

  if (response.RelatedTopics !== undefined) {
    appendTopicResults(response.RelatedTopics, seenUrls, results)
  }

  return results
}

export class DuckDuckGo extends ServiceMap.Service<
  DuckDuckGo,
  {
    readonly search: (
      query: string,
    ) => Effect.Effect<Array<SearchResult>, DuckDuckGoError>
  }
>()("clanka/DuckDuckGo") {
  static readonly make = Effect.gen(function* () {
    const httpClient = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(
        flow(
          HttpClientRequest.prependUrl(API_URL),
          HttpClientRequest.acceptJson,
        ),
      ),
      HttpClient.filterStatusOk,
    )

    const search = Effect.fn("DuckDuckGo.search")(function* (
      query: string,
    ): Effect.fn.Return<Array<SearchResult>, DuckDuckGoError> {
      const normalizedQuery = query.trim()
      if (normalizedQuery === "") {
        return []
      }

      const response = yield* HttpClientRequest.get("/").pipe(
        HttpClientRequest.setUrlParams({
          q: normalizedQuery,
          format: "json",
          no_html: "1",
          no_redirect: "1",
          skip_disambig: "1",
        }),
        httpClient.execute,
        Effect.mapError((cause) =>
          requestFailed("Failed to execute DuckDuckGo search request", cause),
        ),
      )

      const payload = yield* HttpClientResponse.schemaBodyJson(
        DuckDuckGoSearchResponseSchema,
      )(response).pipe(
        Effect.mapError((cause) =>
          decodeFailed("Failed to decode DuckDuckGo search response", cause),
        ),
      )

      return toSearchResults(payload)
    })

    return DuckDuckGo.of({
      search,
    })
  })

  static readonly layer = Layer.effect(DuckDuckGo, DuckDuckGo.make)
}

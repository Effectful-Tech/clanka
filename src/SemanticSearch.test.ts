import { describe, expect, it } from "vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as RequestResolver from "effect/RequestResolver"
import type * as EmbeddingModel from "effect/unstable/ai/EmbeddingModel"
import { makeEmbeddingResolver } from "./SemanticSearch.ts"

const baseResolver = RequestResolver.make<EmbeddingModel.EmbeddingRequest>(
  () => Effect.void,
)

describe("SemanticSearch.makeEmbeddingResolver", () => {
  it("uses embeddingRequestDelay instead of embeddingBatchSize", async () => {
    const resolver = makeEmbeddingResolver(baseResolver, {
      embeddingBatchSize: 1,
      embeddingRequestDelay: Duration.millis(200),
    })

    const [duration] = await Effect.runPromise(Effect.timed(resolver.delay))

    expect(Duration.toMillis(duration)).toBeGreaterThanOrEqual(150)
  })

  it("defaults delay to 50ms regardless of batch size", async () => {
    const resolver = makeEmbeddingResolver(baseResolver, {
      embeddingBatchSize: 999,
    })

    const [duration] = await Effect.runPromise(Effect.timed(resolver.delay))
    const millis = Duration.toMillis(duration)

    expect(millis).toBeGreaterThanOrEqual(20)
    expect(millis).toBeLessThan(800)
  })
})

import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as RequestResolver from "effect/RequestResolver"
import { TestClock } from "effect/testing"
import type * as EmbeddingModel from "effect/unstable/ai/EmbeddingModel"
import { makeEmbeddingResolver } from "./SemanticSearch.ts"

const baseResolver = RequestResolver.make<EmbeddingModel.EmbeddingRequest>(
  () => Effect.void,
)

describe("SemanticSearch.makeEmbeddingResolver", () => {
  it.effect("uses embeddingRequestDelay instead of embeddingBatchSize", () =>
    Effect.gen(function* () {
      const resolver = makeEmbeddingResolver(baseResolver, {
        embeddingBatchSize: 1,
        embeddingRequestDelay: Duration.millis(200),
      })

      const fiber = yield* Effect.forkChild(resolver.delay)

      yield* TestClock.adjust(Duration.millis(199))
      assert.strictEqual(fiber.pollUnsafe(), undefined)

      yield* TestClock.adjust(Duration.millis(1))
      assert.notStrictEqual(fiber.pollUnsafe(), undefined)

      yield* Fiber.join(fiber)
    }),
  )

  it.effect("defaults delay to 50ms regardless of batch size", () =>
    Effect.gen(function* () {
      const resolver = makeEmbeddingResolver(baseResolver, {
        embeddingBatchSize: 999,
      })

      const fiber = yield* Effect.forkChild(resolver.delay)

      yield* TestClock.adjust(Duration.millis(49))
      assert.strictEqual(fiber.pollUnsafe(), undefined)

      yield* TestClock.adjust(Duration.millis(1))
      assert.notStrictEqual(fiber.pollUnsafe(), undefined)

      yield* Fiber.join(fiber)
    }),
  )
})

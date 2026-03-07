import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import * as Example from "./Example.ts"

describe("Example", () => {
  it.effect(
    "should return 'Hello, World!'",
    Effect.fn(function* () {
      yield* TestClock.adjust(1000).pipe(Effect.forkChild)
      const result = yield* Example.program
      assert.strictEqual(result, "Hello, World!")
    }),
  )
})

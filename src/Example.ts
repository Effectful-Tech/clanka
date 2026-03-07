import { Effect } from "effect"

export const program = Effect.gen(function* () {
  yield* Effect.sleep(1000)
  return "Hello, World!"
})

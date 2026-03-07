#!/usr/bin/env node

import { Effect } from "effect"
import { program } from "./index.ts"

const main = Effect.gen(function* () {
  const message = yield* program
  yield* Effect.sync(() => {
    console.log(message)
  })
})

await Effect.runPromise(main).catch((error) => {
  console.error(error)
  throw error
})

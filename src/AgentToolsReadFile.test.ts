import { assert, describe, it } from "@effect/vitest"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as AgentExecutor from "./AgentExecutor.ts"

describe("readFile line numbers", () => {
  const cases = [
    {
      name: "numbers lines by default",
      options: {},
      expected: "1: alpha\n2: beta\n3: gamma\n4: delta",
    },
    {
      name: "numbers lines when explicitly enabled",
      options: { lineNumbers: true },
      expected: "1: alpha\n2: beta\n3: gamma\n4: delta",
    },
    {
      name: "returns unnumbered text when disabled",
      options: { lineNumbers: false },
      expected: "alpha\nbeta\ngamma\ndelta",
    },
    {
      name: "preserves original line numbers for a selected range",
      options: { lineNumbers: true, startLine: 2, endLine: 3 },
      expected: "2: beta\n3: gamma",
    },
  ]

  for (const { name, options, expected } of cases) {
    it.effect(name, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const project = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(
          path.join(project, "sample.txt"),
          "alpha\nbeta\ngamma\ndelta",
        )
        const result = yield* Effect.gen(function* () {
          const executor = yield* AgentExecutor.AgentExecutor
          return yield* executor.executeUnsafe({
            tool: "readFile",
            params: { path: "sample.txt", ...options },
          })
        }).pipe(
          Effect.provide(
            AgentExecutor.layerLocal({ directory: project }).pipe(
              Layer.provide(NodeHttpClient.layerUndici),
            ),
          ),
        )
        assert.strictEqual(result, expected)
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    )
  }
})

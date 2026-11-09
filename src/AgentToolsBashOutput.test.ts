import { assert, describe, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as AgentExecutor from "./AgentExecutor.ts"
import type { Task } from "./AgentTools.ts"

const withExecutor = <A, E, R>(
  test: Effect.Effect<A, E, R>,
  commandOutputChars?: number,
) =>
  test.pipe(
    Effect.provide(
      AgentExecutor.layerLocal({
        directory: ".",
        limits: { commandOutputChars },
      }).pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  )

const outputPath = (task: Task) => {
  const match = task.output.match(/^Full output saved to: ([^\n]+)$/)
  assert.isNotNull(match)
  return match![1]!
}

describe("bash output files", () => {
  it.live(
    "keeps output at the limit inline and saves complete output above it",
    () =>
      withExecutor(
        Effect.gen(function* () {
          const executor = yield* AgentExecutor.AgentExecutor
          const small = (yield* executor.executeUnsafe({
            tool: "bash",
            params: { command: "printf 12345678" },
          })) as Task
          assert.strictEqual(small.output, "12345678")
          const large = (yield* executor.executeUnsafe({
            tool: "bash",
            params: { command: "printf 123456789; printf stderr >&2" },
          })) as Task
          assert.strictEqual(large.status, "completed")
          const fs = yield* FileSystem.FileSystem
          const full = yield* fs.readFileString(outputPath(large))
          assert.include(full, "123456789")
          assert.include(full, "stderr")
          assert.strictEqual(full.length, 15)
          const again = (yield* executor.executeUnsafe({
            tool: "taskOutput",
            params: large.id,
          })) as Task
          assert.strictEqual(again.output, large.output)
        }),
        8,
      ),
  )

  it.live(
    "bounds background output by default and preserves it on failure",
    () =>
      withExecutor(
        Effect.gen(function* () {
          const executor = yield* AgentExecutor.AgentExecutor
          const started = (yield* executor.executeUnsafe({
            tool: "bash",
            params: {
              command: "printf 'é%.0s' {1..40000}; printf END; exit 7",
              background: true,
            },
          })) as Task
          const [finished] = (yield* executor.executeUnsafe({
            tool: "waitTasks",
            params: { ids: [started.id] },
          })) as Array<Task>
          assert.strictEqual(finished!.status, "failed")
          assert.strictEqual(finished!.exitCode, 7)
          assert.isBelow(finished!.output.length, 31000)
          const fs = yield* FileSystem.FileSystem
          assert.strictEqual(
            yield* fs.readFileString(outputPath(finished!)),
            "é".repeat(40000) + "END",
          )
        }),
      ),
  )
})

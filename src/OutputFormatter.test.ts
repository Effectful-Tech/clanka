import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Stream from "effect/Stream"
import * as AgentOutput from "./AgentOutput.ts"
import { layerMuxer, Muxer, pretty } from "./OutputFormatter.ts"

describe("layerMuxer", () => {
  for (const block of ["Reasoning", "Script"] as const) {
    it.effect(
      "keeps concurrent output outside a " + block + " block containing Usage",
      () =>
        Effect.gen(function* () {
          const muxer = yield* Muxer
          const paused = yield* Latch.make()
          const resume = yield* Latch.make()
          const competing = yield* Latch.make()
          const collected = yield* muxer.output.pipe(
            Stream.take(6),
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true }),
          )
          const start =
            block === "Reasoning"
              ? new AgentOutput.ReasoningStart()
              : new AgentOutput.ScriptStart()
          const delta =
            block === "Reasoning"
              ? new AgentOutput.ReasoningDelta({ delta: "text" })
              : new AgentOutput.ScriptDelta({ delta: "text" })
          const end =
            block === "Reasoning"
              ? new AgentOutput.ReasoningEnd()
              : new AgentOutput.ScriptEnd()
          yield* muxer.add(
            Stream.make(
              start,
              delta,
              new AgentOutput.Usage({
                contextTokens: 10,
                inputTokens: 10,
                outputTokens: 2,
                cacheRead: 0,
                cacheWrite: 0,
              }),
            ).pipe(
              Stream.concat(
                Stream.fromEffect(
                  paused.open.pipe(
                    Effect.andThen(resume.await),
                    Effect.as(delta),
                  ),
                ),
              ),
              Stream.concat(Stream.succeed(end)),
            ),
          )
          yield* paused.await
          yield* muxer.add(
            Stream.fromEffect(
              competing.open.pipe(
                Effect.as(
                  new AgentOutput.ScriptOutput({ output: "other agent" }),
                ),
              ),
            ),
          )
          yield* competing.await
          yield* Effect.yieldNow
          yield* resume.open
          const output = yield* Fiber.join(collected)
          assert.deepStrictEqual(output.slice(0, 4), [
            block + "Start",
            block + "Delta",
            block + "Delta",
            block + "End",
          ])
          assert.deepStrictEqual(output.slice(4).toSorted(), [
            "ScriptOutput",
            "Usage",
          ])
        }).pipe(
          Effect.provide(
            layerMuxer((stream) =>
              stream.pipe(
                Stream.map((part) => part._tag),
                Stream.orDie,
              ),
            ),
          ),
        ),
    )
  }
})

describe("pretty", () => {
  for (const block of ["Reasoning", "Script"] as const) {
    for (const termination of ["end", "eof", "finished", "error"] as const) {
      it.effect(block + " defers Usage until " + termination, () =>
        Effect.gen(function* () {
          const start =
            block === "Reasoning"
              ? new AgentOutput.ReasoningStart()
              : new AgentOutput.ScriptStart()
          const delta =
            block === "Reasoning"
              ? new AgentOutput.ReasoningDelta({ delta: "before" })
              : new AgentOutput.ScriptDelta({ delta: "before" })
          const end =
            block === "Reasoning"
              ? new AgentOutput.ReasoningEnd()
              : new AgentOutput.ScriptEnd()
          const tail: Stream.Stream<
            AgentOutput.Output,
            AgentOutput.AgentFinished | string
          > =
            termination === "end"
              ? Stream.succeed(end)
              : termination === "eof"
                ? Stream.empty
                : termination === "finished"
                  ? Stream.fail(
                      new AgentOutput.AgentFinished({ summary: "done" }),
                    )
                  : Stream.fail("failure")
          const output = yield* Stream.make(
            start,
            delta,
            new AgentOutput.Usage({
              contextTokens: 10,
              inputTokens: 10,
              outputTokens: 2,
              cacheRead: 0,
              cacheWrite: 0,
            }),
            block === "Reasoning"
              ? new AgentOutput.ReasoningDelta({ delta: "after" })
              : new AgentOutput.ScriptDelta({ delta: "after" }),
          ).pipe(
            Stream.concat(tail),
            pretty(),
            Stream.catchCause((cause) => Stream.succeed(Cause.pretty(cause))),
            Stream.runCollect,
          )
          assert.include(output[2], "after")
          assert.strictEqual(output[3], "\n\n")
          assert.include(output[4], "Usage:")
          assert.include(output[4], "10 context / 10 input / 2 output")
          if (termination === "finished")
            assert.include(output[5], "Task complete:")
          if (termination === "error") assert.include(output[5], "failure")
        }),
      )
    }
  }
})

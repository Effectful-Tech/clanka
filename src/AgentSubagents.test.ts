import { assert, describe, it } from "@effect/vitest"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpServer from "effect/http/HttpServer"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as MutableRef from "effect/MutableRef"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as AiError from "effect/ai/AiError"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import * as Prompt from "effect/ai/Prompt"
import type * as Response from "effect/ai/Response"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import * as Agent from "./Agent.ts"
import * as AgentExecutor from "./AgentExecutor.ts"
import type { Output } from "./AgentOutput.ts"

// =============================================================================
// Agent tasks: lifetime and completion delivery.
//
// These drive the real Agent loop and a real executor, so the model only
// talks to the script API: `subagent({ prompt, background })`, `waitTasks`,
// `messageAgent`, `stopTask`, `listTasks` and `taskOutput`. One scripted
// LanguageModel serves every agent; calls are routed by the task marker in
// each agent's first user message. Task IDs come from the executor's counter,
// shared by bash and agent tasks. Each test gets its own executor, so the
// first task is "1".
//
// Sub-agents always finish with `taskComplete`: with the local executor they
// currently run outside the parent's ConversationMode, so a text-only turn
// does not end them.
// =============================================================================

type Role = "root" | "child" | "grandchild"

interface Call {
  readonly role: Role
  readonly index: number
  readonly prompt: Prompt.Prompt
}

type Respond = (
  call: Call,
) => Stream.Stream<Response.StreamPartEncoded, AiError.AiError>

const messageText = (message: Prompt.Message): string =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")

const firstUserText = (prompt: Prompt.Prompt): string => {
  const message = prompt.content.find((message) => message.role === "user")
  return message ? messageText(message) : ""
}

const roleOf = (prompt: Prompt.Prompt): Role => {
  const text = firstUserText(prompt)
  if (text.includes("TASK-GRANDCHILD")) return "grandchild"
  if (text.includes("TASK-CHILD")) return "child"
  return "root"
}

const runAgent = (options: {
  readonly conversationMode: boolean
  readonly respond: Respond
  readonly onOutput?: ((output: Output) => Effect.Effect<void>) | undefined
  readonly afterExit?: Effect.Effect<void> | undefined
}) =>
  Effect.gen(function* () {
    const executor = yield* AgentExecutor.AgentExecutor
    const calls: Array<Call> = []
    const counts: Record<Role, number> = { root: 0, child: 0, grandchild: 0 }
    const languageModel = yield* LanguageModel.make({
      generateText: () => Effect.die("unexpected generateText call"),
      streamText: (providerOptions) => {
        const role = roleOf(providerOptions.prompt)
        const call: Call = {
          role,
          index: counts[role]++,
          prompt: providerOptions.prompt,
        }
        calls.push(call)
        return options.respond(call)
      },
    })
    const modelLayer = Layer.mergeAll(
      Layer.succeed(LanguageModel.LanguageModel, languageModel),
      Layer.succeed(Model.ProviderName, "test-provider"),
      Layer.succeed(Model.ModelName, "test-model"),
    )
    const agent = yield* Agent.make.pipe(
      Effect.provideService(AgentExecutor.AgentExecutor, executor),
    )
    const exit = yield* agent.send({ prompt: "hello" }).pipe(
      Effect.flatMap((stream) =>
        stream.pipe(
          Stream.runForEach(options.onOutput ?? (() => Effect.void)),
          Effect.as(""),
          Effect.catchTag("AgentFinished", (finished) =>
            Effect.succeed(finished.summary),
          ),
        ),
      ),
      Effect.provide(
        Layer.mergeAll(
          modelLayer,
          Agent.ConversationMode.layer(options.conversationMode),
          Agent.layerSubagentModel(modelLayer),
        ),
      ),
      Effect.exit,
    )
    // Still inside the scope that owns the Agent, so anything observed here
    // was cleaned up by the run itself, not by the test tearing down.
    if (options.afterExit) yield* options.afterExit
    return { exit, calls, history: MutableRef.get(agent.history) }
  }).pipe(Effect.scoped, Effect.timeout("4 seconds"))

// --- fixtures ----------------------------------------------------------------

const toolCall = (id: string, script: string): Response.StreamPartEncoded => ({
  type: "tool-call",
  id,
  name: "execute",
  params: { script },
})

const text = (content: string, id = "t"): Array<Response.StreamPartEncoded> => [
  { type: "text-start", id },
  { type: "text-delta", id, delta: content },
  { type: "text-end", id },
]

const invalidRequest = AiError.make({
  module: "OpenAiLanguageModel",
  method: "streamText",
  reason: new AiError.InvalidRequestError({
    description: "The sub-agent request was rejected",
  }),
})

const complete = (output: string) =>
  Stream.make(
    toolCall("complete", `await taskComplete(${JSON.stringify(output)})`),
  )

const spawnBackground = (task: string) =>
  toolCall(
    `spawn-${task}`,
    `const result = await subagent({ prompt: "${task}", background: true })
console.log(JSON.stringify(result))`,
  )

const toolResultTexts = (prompt: Prompt.Prompt): Array<string> =>
  prompt.content.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) =>
          part.type === "tool-result" ? [String(part.result)] : [],
        )
      : [],
  )

const lastToolResult = (prompt: Prompt.Prompt): string =>
  toolResultTexts(prompt).at(-1) ?? ""

const encodePrompt = Schema.encodeSync(Prompt.Prompt)
const messageJsons = (prompt: Prompt.Prompt): Array<string> =>
  encodePrompt(prompt).content.map((message) => JSON.stringify(message))

/**
 * The index and text of the first user message carrying a completion push
 * for `id` with `status`, or -1 / "" when there is none.
 */
const findPush = (
  prompt: Prompt.Prompt,
  id: string,
  status: "completed" | "failed" | "stopped",
): { readonly index: number; readonly text: string } => {
  const pattern = new RegExp(
    `<task id="${id}" kind="agent" status="${status}">[\\s\\S]*</task>`,
  )
  const index = prompt.content.findIndex(
    (message) => message.role === "user" && pattern.test(messageText(message)),
  )
  return {
    index,
    text: index === -1 ? "" : messageText(prompt.content[index]!),
  }
}

const pushTexts = (prompt: Prompt.Prompt): Array<string> =>
  prompt.content.flatMap((message) => {
    if (message.role !== "user") return []
    const text = messageText(message)
    return text.includes("<task id=") ? [text] : []
  })

const hasAnyPush = (prompt: Prompt.Prompt, id: string): boolean =>
  pushTexts(prompt).some((push) => push.includes(`<task id="${id}"`))

const waitFor = (condition: () => boolean) =>
  Effect.gen(function* () {
    while (!condition()) yield* Effect.sleep("10 millis")
  }).pipe(Effect.timeoutOption("1 second"), Effect.map(Option.isSome))

const unexpected = (call: Call) =>
  Stream.die(`unexpected ${call.role} model call #${call.index}`)

// --- executors ---------------------------------------------------------------

const localExecutorLayer = (limits?: AgentExecutor.Limits) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      return AgentExecutor.layerLocal({ directory, limits })
    }),
  ).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  )

const rpcExecutorLayer = (limits?: AgentExecutor.Limits) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const { protocol, httpEffect } =
        yield* RpcServer.makeProtocolWithHttpEffect()
      yield* Layer.build(
        AgentExecutor.layerRpcServer({ directory, limits }).pipe(
          Layer.provide(Layer.succeed(RpcServer.Protocol, protocol)),
        ),
      )
      yield* HttpServer.serveEffect(httpEffect)
      return AgentExecutor.layerRpc.pipe(
        Layer.provide(RpcClient.layerProtocolHttp({ url: "" })),
      )
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        RpcSerialization.layerNdjson,
        NodeHttpServer.layerTest,
        NodeServices.layer,
      ),
    ),
  )

const executors = [
  ["local", localExecutorLayer],
  ["rpc", rpcExecutorLayer],
] as const

// --- tests -------------------------------------------------------------------

for (const [executorName, executorLayer] of executors) {
  // A fresh executor per test keeps task ids predictable.
  const test = (
    name: string,
    self: () => Effect.Effect<void, unknown, AgentExecutor.AgentExecutor>,
    limits?: AgentExecutor.Limits,
  ) => it.live(name, () => self().pipe(Effect.provide(executorLayer(limits))))

  describe(`agent tasks (${executorName} executor)`, () => {
    test("an idle conversation turn waits for a running child, then gets an output retrieval call", () =>
      Effect.gen(function* () {
        const childRelease = Latch.makeUnsafe(false)
        const childOutput = "CHILD-HEAD " + "x".repeat(40_000) + " CHILD-TAIL"
        const { exit, calls } = yield* runAgent({
          conversationMode: true,
          respond: (call) => {
            if (call.role === "child") {
              // Finishes only after the parent's idle turn is over, so
              // the parent has to block on the completion push.
              return Stream.fromEffect(
                childRelease.await.pipe(
                  Effect.andThen(Effect.sleep("50 millis")),
                ),
              ).pipe(Stream.flatMap(() => complete(childOutput)))
            }
            switch (call.index) {
              case 0:
                return Stream.make(spawnBackground("TASK-CHILD"))
              case 1:
                return Stream.fromIterable(text("waiting for the child")).pipe(
                  Stream.ensuring(Effect.sync(() => childRelease.openUnsafe())),
                )
              case 2:
                return Stream.make(
                  toolCall(
                    "read",
                    `console.log((await taskOutput("1")).output)`,
                  ),
                )
              case 3:
                return Stream.fromIterable(text("all done"))
              default:
                return unexpected(call)
            }
          },
        })

        assert.deepStrictEqual(exit, Exit.succeed("all done"))
        const root = calls.filter((call) => call.role === "root")
        assert.strictEqual(root.length, 4)

        const started = lastToolResult(root[1]!.prompt)
        assert.include(started, '"id":"1"')
        assert.include(started, '"kind":"agent"')
        assert.include(started, '"status":"running"')
        assert.include(started, '"description":"TASK-CHILD"')

        const push = findPush(root[2]!.prompt, "1", "completed")
        assert.notStrictEqual(push.index, -1, "completion push delivered")
        assert.include(push.text, 'taskOutput("1")')
        assert.notInclude(push.text, "CHILD-HEAD")
        assert.notInclude(push.text, "CHILD-TAIL")
        assert.include(lastToolResult(root[3]!.prompt), "CHILD-HEAD")
        assert.include(lastToolResult(root[3]!.prompt), "CHILD-TAIL")
      }))

    test("a completion push does not cut off the parent's in-progress response", () =>
      Effect.gen(function* () {
        const childRelease = Latch.makeUnsafe(false)
        const completionDelivered = Latch.makeUnsafe(false)
        const { exit, calls } = yield* runAgent({
          conversationMode: true,
          onOutput: (output) =>
            Effect.sync(() => {
              if (output._tag === "SubagentComplete" && output.id === 1) {
                assert.strictEqual(output.status, "completed")
                assert.strictEqual(output.summary, "CHILD-RESULT")
                completionDelivered.openUnsafe()
              }
            }),
          respond: (call) => {
            if (call.role === "child") {
              return Stream.fromEffect(childRelease.await).pipe(
                Stream.flatMap(() => complete("CHILD-RESULT")),
              )
            }
            switch (call.index) {
              case 0:
                return Stream.make(spawnBackground("TASK-CHILD"))
              case 1:
                // The child completes between two text blocks of one
                // response. The whole response must still be recorded.
                return Stream.fromIterable(text("PART-ONE", "t1")).pipe(
                  Stream.concat(
                    Stream.fromEffect(
                      Effect.gen(function* () {
                        childRelease.openUnsafe()
                        // Unlike the child model stream ending, this event
                        // means cleanup finished and the push was queued.
                        yield* completionDelivered.await
                      }),
                    ).pipe(Stream.drain),
                  ),
                  Stream.concat(
                    Stream.fromIterable([
                      ...text("PART-TWO", "t2"),
                      toolCall("after", 'console.log("AFTER-SCRIPT-RAN")'),
                    ]),
                  ),
                )
              default:
                return Stream.fromIterable(text("done"))
            }
          },
        })

        assert.deepStrictEqual(exit, Exit.succeed("done"))
        const root = calls.filter((call) => call.role === "root")
        const delivery = root.find(
          (call) => findPush(call.prompt, "1", "completed").index !== -1,
        )
        assert.isDefined(delivery, "completion push reached the model")
        const prompt = delivery!.prompt
        const assistantIndex = prompt.content.findIndex(
          (message) =>
            message.role === "assistant" &&
            messageText(message).includes("PART-ONE"),
        )
        assert.notStrictEqual(assistantIndex, -1)
        assert.include(
          messageText(prompt.content[assistantIndex]!),
          "PART-TWO",
          "the response continued past the first text-end",
        )
        assert.include(
          lastToolResult(prompt),
          "AFTER-SCRIPT-RAN",
          "the tool call after the push still ran",
        )
        const push = findPush(prompt, "1", "completed")
        assert.include(push.text, 'taskOutput("1")')
        assert.isAbove(
          push.index,
          assistantIndex,
          "the push is injected after the response, not into it",
        )
      }))

    test("a failed background child is pushed as failed and the parent keeps going", () =>
      Effect.gen(function* () {
        const childRelease = Latch.makeUnsafe(false)
        const { exit, calls } = yield* runAgent({
          conversationMode: true,
          respond: (call) => {
            if (call.role === "child") {
              return Stream.fromEffect(childRelease.await).pipe(
                Stream.flatMap(() => Stream.fail(invalidRequest)),
              )
            }
            switch (call.index) {
              case 0:
                return Stream.make(spawnBackground("TASK-CHILD"))
              case 1:
                return Stream.fromIterable(text("waiting")).pipe(
                  Stream.ensuring(Effect.sync(() => childRelease.openUnsafe())),
                )
              case 2:
                return Stream.fromIterable(text("recovered"))
              default:
                return unexpected(call)
            }
          },
        })

        assert.deepStrictEqual(exit, Exit.succeed("recovered"))
        const root = calls.filter((call) => call.role === "root")
        const push = findPush(root[2]!.prompt, "1", "failed")
        assert.notStrictEqual(push.index, -1, "failure push delivered")
        assert.include(push.text, 'taskOutput("1")')
        assert.notInclude(push.text, "rejected")
      }))

    test("taskComplete fails while a child is running and leaves it running", () =>
      Effect.gen(function* () {
        const childRelease = Latch.makeUnsafe(false)
        const { exit, calls, history } = yield* runAgent({
          conversationMode: false,
          respond: (call) => {
            if (call.role === "child") {
              return call.index === 0
                ? Stream.fromEffect(childRelease.await).pipe(
                    Stream.flatMap(() => complete("CHILD-RESULT")),
                  )
                : unexpected(call)
            }
            switch (call.index) {
              case 0:
                return Stream.make(
                  toolCall(
                    "too-early",
                    `await subagent({ prompt: "TASK-CHILD", background: true })
try {
  await taskComplete("too early")
  console.log("ACCEPTED")
} catch (error) {
  console.log("REJECTED: " + String(error))
}`,
                  ),
                )
              case 1: {
                const rejected = lastToolResult(call.prompt)
                assert.include(rejected, "REJECTED")
                assert.notInclude(rejected, "ACCEPTED")
                assert.include(
                  rejected,
                  'waitTasks({ ids: ["1"] })',
                  "quotes the call that waits for the running child",
                )
                assert.include(rejected, "stopTask")
                childRelease.openUnsafe()
                return Stream.make(
                  toolCall(
                    "wait",
                    `const results = await waitTasks({ ids: ["1"] })
console.log(JSON.stringify(results))
await taskComplete("done")`,
                  ),
                )
              }
              default:
                return unexpected(call)
            }
          },
        })

        assert.deepStrictEqual(exit, Exit.succeed("done"))
        assert.strictEqual(
          calls.filter((call) => call.role === "root").length,
          2,
        )
        const waited = lastToolResult(history)
        assert.include(waited, '"id":"1"')
        assert.include(
          waited,
          '"status":"completed"',
          "the child was not cancelled by the refused taskComplete",
        )
        assert.include(waited, "CHILD-RESULT")
      }))

    test("background children do not outlive the parent run", () =>
      Effect.gen(function* () {
        const childStarted = Latch.makeUnsafe(false)
        let childInterrupted = false
        let interruptedBeforeTeardown = false
        const { exit } = yield* runAgent({
          conversationMode: true,
          respond: (call) => {
            if (call.role === "child") {
              return Stream.fromEffect(
                Effect.sync(() => childStarted.openUnsafe()).pipe(
                  Effect.andThen(Effect.never),
                ),
              ).pipe(
                Stream.ensuring(
                  Effect.sync(() => {
                    childInterrupted = true
                  }),
                ),
              )
            }
            switch (call.index) {
              case 0:
                return Stream.make(spawnBackground("TASK-CHILD"))
              case 1:
                // The parent run fails while its child is still running.
                return Stream.fromEffect(childStarted.await).pipe(
                  Stream.flatMap(() => Stream.fail(invalidRequest)),
                )
              default:
                return unexpected(call)
            }
          },
          afterExit: waitFor(() => childInterrupted).pipe(
            Effect.map((interrupted) => {
              interruptedBeforeTeardown = interrupted
            }),
          ),
        })

        assert.isTrue(Exit.isFailure(exit), "the parent run fails")
        assert.isTrue(
          interruptedBeforeTeardown,
          "the child is interrupted when the run ends",
        )
      }))

    test("stopTask stops the agent and everything under it", () =>
      Effect.gen(function* () {
        const grandchildStarted = Latch.makeUnsafe(false)
        const childBlocked = Latch.makeUnsafe(false)
        let childInterrupted = false
        let grandchildInterrupted = false
        let interruptedBeforeNextTurn = false
        const { exit, calls } = yield* runAgent({
          conversationMode: true,
          respond: (call) => {
            switch (call.role) {
              case "grandchild":
                return Stream.fromEffect(
                  Effect.sync(() => grandchildStarted.openUnsafe()).pipe(
                    Effect.andThen(Effect.never),
                  ),
                ).pipe(
                  Stream.ensuring(
                    Effect.sync(() => {
                      grandchildInterrupted = true
                    }),
                  ),
                )
              case "child":
                return call.index === 0
                  ? Stream.make(spawnBackground("TASK-GRANDCHILD"))
                  : Stream.fromEffect(
                      Effect.sync(() => childBlocked.openUnsafe()).pipe(
                        Effect.andThen(Effect.never),
                      ),
                    ).pipe(
                      Stream.ensuring(
                        Effect.sync(() => {
                          childInterrupted = true
                        }),
                      ),
                    )
              case "root":
                switch (call.index) {
                  case 0:
                    return Stream.make(spawnBackground("TASK-CHILD"))
                  case 1:
                    return Stream.fromEffect(grandchildStarted.await).pipe(
                      Stream.tap(() => childBlocked.await),
                      Stream.as(
                        toolCall(
                          "stop",
                          `console.log("STOP-VOID:", (await stopTask("1")) === undefined)
console.log(JSON.stringify(await taskOutput("1")))`,
                        ),
                      ),
                    )
                  default:
                    if (call.index === 2) {
                      interruptedBeforeNextTurn =
                        childInterrupted && grandchildInterrupted
                    }
                    return Stream.fromIterable(text("stopped"))
                }
            }
          },
        })

        assert.deepStrictEqual(exit, Exit.succeed("stopped"))
        const root = calls.filter((call) => call.role === "root")
        const stopped = lastToolResult(root[2]!.prompt)
        assert.include(stopped, "STOP-VOID: true")
        assert.include(stopped, '"id":"1"')
        assert.include(stopped, '"status":"stopped"')
        assert.isTrue(
          interruptedBeforeNextTurn,
          "stopTask interrupts the child and its grandchild before returning",
        )
      }))

    test("messageAgent returns void when steering a running child", () =>
      Effect.gen(function* () {
        const childStarted = Latch.makeUnsafe(false)
        const childRelease = Latch.makeUnsafe(false)
        const { exit, calls } = yield* runAgent({
          conversationMode: true,
          respond: (call) => {
            if (call.role === "child") {
              if (call.index === 0) {
                return Stream.fromEffect(
                  Effect.sync(() => childStarted.openUnsafe()).pipe(
                    Effect.andThen(childRelease.await),
                  ),
                ).pipe(Stream.flatMap(() => Stream.fromIterable(text("ready"))))
              }
              return complete("STEERED-ANSWER")
            }
            if (call.index === 0) {
              return Stream.make(spawnBackground("TASK-CHILD"))
            }
            if (call.index === 1) {
              return Stream.fromEffect(childStarted.await).pipe(
                Stream.as(
                  toolCall(
                    "message",
                    `console.log("MESSAGE-VOID:", (await messageAgent({ id: "1", message: "STEER" })) === undefined)`,
                  ),
                ),
              )
            }
            childRelease.openUnsafe()
            return Stream.fromIterable(text("steered"))
          },
        })

        assert.deepStrictEqual(exit, Exit.succeed("steered"))
        const root = calls.filter((call) => call.role === "root")
        assert.include(lastToolResult(root[2]!.prompt), "MESSAGE-VOID: true")
        const steered = calls.find(
          (call) => call.role === "child" && call.index === 1,
        )
        assert.isDefined(steered, "the running child received the message")
        assert.include(JSON.stringify(steered!.prompt), "STEER")
      }))

    test("messageAgent resumes a finished child on top of its history", () =>
      Effect.gen(function* () {
        let messageCall: number | undefined
        let resumedPrompt: Prompt.Prompt | undefined
        const { exit, calls } = yield* runAgent({
          conversationMode: true,
          respond: (call) => {
            if (call.role === "child") {
              switch (call.index) {
                case 0:
                  return complete("FIRST-ANSWER")
                case 1:
                  resumedPrompt = call.prompt
                  return complete("SECOND-ANSWER")
                default:
                  return unexpected(call)
              }
            }
            // Decide from what has been delivered, not from call order:
            // pushes may land before or after an idle turn.
            const pushes = pushTexts(call.prompt)
            if (call.index === 0) {
              return Stream.make(spawnBackground("TASK-CHILD"))
            }
            if (pushes.length === 2) {
              return Stream.fromIterable(text("resumed"))
            }
            if (messageCall === undefined && pushes.length === 1) {
              messageCall = call.index
              return Stream.make(
                toolCall(
                  "message",
                  `const result = await messageAgent({ id: "1", message: "FOLLOW-UP" })
console.log("MESSAGE-VOID:", result === undefined)`,
                ),
              )
            }
            return Stream.fromIterable(text("waiting"))
          },
        })

        assert.deepStrictEqual(exit, Exit.succeed("resumed"))
        assert.isDefined(messageCall, "the first completion was pushed")
        const root = calls.filter((call) => call.role === "root")
        const messaged = lastToolResult(root[messageCall! + 1]!.prompt)
        assert.include(messaged, "MESSAGE-VOID: true")

        assert.isDefined(resumedPrompt, "the finished child was resumed")
        const resumed = messageJsons(resumedPrompt!)
        const task = resumed.findIndex((m) => m.includes("TASK-CHILD"))
        const first = resumed.findIndex((m) => m.includes("FIRST-ANSWER"))
        const followUp = resumed.findIndex((m) => m.includes("FOLLOW-UP"))
        assert.notStrictEqual(task, -1, "original task kept")
        assert.isAbove(first, task, "first answer kept")
        assert.isAbove(followUp, first, "message appended after history")
      }))

    test("pushes go to the agent that spawned the child, at every level", () =>
      Effect.gen(function* () {
        const { exit, calls } = yield* runAgent({
          conversationMode: true,
          respond: (call) => {
            switch (call.role) {
              case "grandchild":
                return complete("GRAND-RESULT")
              case "child":
                if (
                  findPush(call.prompt, "2", "completed").text.includes(
                    'taskOutput("2")',
                  )
                ) {
                  return complete("CHILD-DONE")
                }
                // Keep taking turns until the push is drained into the
                // child's own prompt.
                return call.index === 0
                  ? Stream.make(spawnBackground("TASK-GRANDCHILD"))
                  : Stream.fromEffect(Effect.sleep("20 millis")).pipe(
                      Stream.flatMap(() =>
                        Stream.fromIterable(text("child waiting")),
                      ),
                    )
              case "root":
                switch (call.index) {
                  case 0:
                    // Foreground: blocks until the child is done.
                    return Stream.make(
                      toolCall(
                        "foreground",
                        `const result = await subagent({ prompt: "TASK-CHILD" })
console.log(JSON.stringify(result))`,
                      ),
                    )
                  case 1:
                    return Stream.fromIterable(text("root done"))
                  default:
                    return unexpected(call)
                }
            }
          },
        })

        assert.deepStrictEqual(exit, Exit.succeed("root done"))
        const root = calls.filter((call) => call.role === "root")
        assert.strictEqual(root.length, 2)
        const foreground = lastToolResult(root[1]!.prompt)
        assert.include(foreground, '"id":"1"')
        assert.include(foreground, '"status":"completed"')
        assert.include(foreground, "CHILD-DONE")
        for (const call of root) {
          assert.isFalse(
            hasAnyPush(call.prompt, "2"),
            "the grandchild's push never reaches the root",
          )
        }
      }))

    test("each agent keeps its own working directory, starting from its parent's", () =>
      Effect.gen(function* () {
        // Both children change directory before either prints it, so a
        // shared directory shows up as the wrong path.
        const bothChanged = Latch.makeUnsafe(false)
        let changed = 0
        const { exit, calls } = yield* runAgent({
          conversationMode: true,
          respond: (call) => {
            if (call.role === "child") {
              const name = firstUserText(call.prompt).includes("ONE")
                ? "one"
                : "two"
              if (toolResultTexts(call.prompt).length === 0) {
                return Stream.make(
                  toolCall(`cd-${name}`, `await changeDirectory("${name}")`),
                )
              }
              if (++changed === 2) bothChanged.openUnsafe()
              return Stream.fromEffect(bothChanged.await).pipe(
                Stream.flatMap(() =>
                  Stream.make(
                    toolCall(
                      `pwd-${name}`,
                      `const pwd = await bash({ command: "pwd" })
await taskComplete("${name.toUpperCase()}:" + pwd.output.trim())`,
                    ),
                  ),
                ),
              )
            }
            switch (call.index) {
              case 0:
                return Stream.make(
                  toolCall(
                    "spawn",
                    `await bash({ command: "mkdir -p a/one a/two" })
await changeDirectory("a")
const one = await subagent({ prompt: "TASK-CHILD-ONE", background: true })
const two = await subagent({ prompt: "TASK-CHILD-TWO", background: true })
console.log(JSON.stringify(await waitTasks({ ids: [one.id, two.id] })))
console.log("ROOT:" + (await bash({ command: "pwd" })).output.trim())`,
                  ),
                )
              case 1:
                return Stream.fromIterable(text("done"))
              default:
                return unexpected(call)
            }
          },
        })

        assert.deepStrictEqual(exit, Exit.succeed("done"))
        const root = calls.filter((call) => call.role === "root")
        const result = lastToolResult(root[1]!.prompt)
        assert.match(result, /ONE:[^"\s]*\/a\/one"/)
        assert.match(result, /TWO:[^"\s]*\/a\/two"/)
        assert.match(result, /ROOT:\S*\/a$/m)
      }))

    test("waitTasks waits for bash and agent tasks alike, and what it returns is not pushed", () =>
      Effect.gen(function* () {
        const { exit, calls } = yield* runAgent({
          conversationMode: true,
          respond: (call) => {
            if (call.role === "child") return complete("CHILD-OUT")
            switch (call.index) {
              case 0:
                return Stream.make(
                  toolCall(
                    "mixed",
                    `const bashTask = await bash({ command: "echo BASH-OUT", background: true })
const agentTask = await subagent({ prompt: "TASK-CHILD", background: true })
const ended = await waitTasks({ ids: [bashTask.id, agentTask.id] })
console.log(JSON.stringify(ended.map(({ kind, status, output }) => ({ kind, status, output: output.trim() }))))`,
                  ),
                )
              case 1:
                return Stream.fromIterable(text("done"))
              default:
                return unexpected(call)
            }
          },
        })

        assert.deepStrictEqual(exit, Exit.succeed("done"))
        const root = calls.filter((call) => call.role === "root")
        assert.strictEqual(root.length, 2, "no late push wakes the run")
        assert.include(
          lastToolResult(root[1]!.prompt),
          JSON.stringify([
            { kind: "bash", status: "completed", output: "BASH-OUT" },
            { kind: "agent", status: "completed", output: "CHILD-OUT" },
          ]),
        )
        assert.deepStrictEqual(
          pushTexts(root[1]!.prompt),
          [],
          "results returned by waitTasks are not pushed again",
        )
      }))

    test("an agent only sees and addresses its own tasks", () =>
      Effect.gen(function* () {
        const { exit, calls } = yield* runAgent({
          conversationMode: true,
          respond: (call) => {
            if (call.role === "child") {
              // The parent's bash task id, passed in the task prompt.
              const bashId = /BASH-ID:(\w+)/.exec(
                firstUserText(call.prompt),
              )![1]
              return Stream.make(
                toolCall(
                  "peek",
                  `const seen = (await listTasks()).map((task) => task.id)
const attempts = []
for (const attempt of [() => taskOutput("${bashId}"), () => stopTask("${bashId}")]) {
  try {
    await attempt()
    attempts.push("allowed")
  } catch {
    attempts.push("rejected")
  }
}
await taskComplete(JSON.stringify({ seen, attempts }))`,
                ),
              )
            }
            switch (call.index) {
              case 0:
                return Stream.make(
                  toolCall(
                    "spawn",
                    `const server = await bash({ command: "sleep 30", background: true })
const child = await subagent({ prompt: "TASK-CHILD BASH-ID:" + server.id })
console.log("CHILD:" + child.output)
const mine = await listTasks()
console.log("ROOT:" + JSON.stringify(mine.map((task) => task.kind + ":" + task.status).sort()))`,
                  ),
                )
              case 1:
                return Stream.fromIterable(text("done"))
              default:
                return unexpected(call)
            }
          },
        })

        assert.deepStrictEqual(exit, Exit.succeed("done"))
        const root = calls.filter((call) => call.role === "root")
        const result = lastToolResult(root[1]!.prompt)
        assert.include(
          result,
          'CHILD:{"seen":[],"attempts":["rejected","rejected"]}',
          "the child neither lists nor addresses its parent's bash task",
        )
        assert.include(
          result,
          'ROOT:["agent:completed","bash:running"]',
          "the parent lists both of its tasks, and its bash task still runs",
        )
      }))

    // A bounded wait that passes its deadline returns the agent as running and
    // leaves it running; its result is pushed when it ends.
    test("waitTasks returns a running agent at its deadline and leaves it running", () =>
      Effect.gen(function* () {
        const childRelease = Latch.makeUnsafe(false)
        let childInterrupted = false
        let waited = ""
        const { exit, calls } = yield* runAgent({
          conversationMode: true,
          respond: (call) => {
            if (call.role === "child") {
              return call.index === 0
                ? Stream.fromEffect(
                    childRelease.await.pipe(
                      Effect.onInterrupt(() =>
                        Effect.sync(() => {
                          childInterrupted = true
                        }),
                      ),
                    ),
                  ).pipe(Stream.flatMap(() => complete("CHILD-LATE")))
                : unexpected(call)
            }
            switch (call.index) {
              case 0:
                return Stream.make(
                  toolCall(
                    "wait",
                    `const child = await subagent({ prompt: "TASK-CHILD", background: true })
const [task] = await waitTasks({ ids: [child.id], timeoutMs: 200 })
console.log("WAITED:" + task.status)`,
                  ),
                )
              case 1:
                waited = lastToolResult(call.prompt)
                // The child ends only now, after the wait gave up.
                return Stream.fromIterable(text("waiting")).pipe(
                  Stream.ensuring(Effect.sync(() => childRelease.openUnsafe())),
                )
              case 2:
                return Stream.fromIterable(text("done"))
              default:
                return unexpected(call)
            }
          },
        })

        assert.include(waited, "WAITED:running", "returned at the deadline")
        assert.isFalse(childInterrupted, "the deadline does not stop the agent")
        assert.deepStrictEqual(exit, Exit.succeed("done"))
        const root = calls.filter((call) => call.role === "root")
        assert.strictEqual(root.length, 3)
        assert.include(
          findPush(root[2]!.prompt, "1", "completed").text,
          'taskOutput("1")',
          "its completion is pushed once it ends",
        )
      }))

    // The script times out while `waitTasks` still waits for the slow task,
    // so it never returns the two that ended. They must still be pushed.
    test(
      "tasks a waitTasks call never returned are still pushed",
      () =>
        Effect.gen(function* () {
          const { exit, calls } = yield* runAgent({
            conversationMode: true,
            respond: (call) => {
              if (call.role === "child") return complete("CHILD-OUT")
              switch (call.index) {
                case 0:
                  return Stream.make(
                    toolCall(
                      "wait",
                      `const quick = await bash({ command: "echo BASH-OUT", background: true })
const child = await subagent({ prompt: "TASK-CHILD", background: true })
const slow = await bash({ command: "sleep 30", background: true })
await waitTasks({ ids: [quick.id, child.id, slow.id] })
console.log("RETURNED")`,
                    ),
                  )
                case 1:
                  return Stream.fromIterable(text("done"))
                default:
                  return unexpected(call)
              }
            },
          })

          assert.deepStrictEqual(exit, Exit.succeed("done"))
          const root = calls.filter((call) => call.role === "root")
          const result = lastToolResult(root[1]!.prompt)
          assert.include(result, "timed out")
          assert.notInclude(result, "RETURNED")
          assert.isTrue(
            pushTexts(root[1]!.prompt).some((push) =>
              /^<task id="1" kind="bash" status="completed" exitCode="0">\s*To read the output, call taskOutput\("1"\)\.\s*<\/task>$/.test(
                push,
              ),
            ),
            "the bash task is pushed",
          )
          assert.include(
            findPush(root[1]!.prompt, "2", "completed").text,
            'taskOutput("2")',
            "the agent task is pushed",
          )
        }),
      { scriptTimeout: "1 second" },
    )
  })
}

// Over RPC every task callback is a round trip to the client. Responses that
// take 400ms each, against a 1 second script limit, leave no time for one
// round trip per agent after the wait: all of the batch must be reported in
// one, or results that were marked reported are neither returned nor pushed.
const slow = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.tap(effect, () => Effect.sleep("400 millis"))

const slowCallbacks = (
  tasks: AgentExecutor.ExecuteAgentTasks,
): AgentExecutor.ExecuteAgentTasks => ({
  ...tasks,
  taskOutput: (id) => slow(tasks.taskOutput(id)),
  waitTasks: (...args) => slow(tasks.waitTasks(...args)),
  messageAgent: (options) => slow(tasks.messageAgent(options)),
  stopTask: (id) => slow(tasks.stopTask(id)),
  listTasks: slow(tasks.listTasks),
})

describe("agent tasks (rpc executor, slow callbacks)", () => {
  it.live("every result of a waitTasks batch reaches the model", () =>
    Effect.gen(function* () {
      const executor = yield* AgentExecutor.AgentExecutor
      const slowExecutor = AgentExecutor.AgentExecutor.of({
        ...executor,
        execute: (options) =>
          executor.execute({
            ...options,
            agentTasks: slowCallbacks(options.agentTasks),
          }),
      })
      const { exit, calls } = yield* runAgent({
        conversationMode: true,
        respond: (call) => {
          if (call.role === "child") {
            return complete(
              firstUserText(call.prompt).includes("TASK-CHILD-A")
                ? "CHILD-A-OUT"
                : "CHILD-B-OUT",
            )
          }
          switch (call.index) {
            case 0:
              return Stream.make(
                toolCall(
                  "wait",
                  `const a = await subagent({ prompt: "TASK-CHILD-A", background: true })
const b = await subagent({ prompt: "TASK-CHILD-B", background: true })
const ended = await waitTasks({ ids: [a.id, b.id] })
console.log(ended.map((task) => task.output).join(" "))`,
                ),
              )
            case 1:
              return Stream.fromIterable(text("done"))
            default:
              return unexpected(call)
          }
        },
      }).pipe(Effect.provideService(AgentExecutor.AgentExecutor, slowExecutor))

      assert.deepStrictEqual(exit, Exit.succeed("done"))
      const prompt = calls.filter((call) => call.role === "root")[1]!.prompt
      const seen = [lastToolResult(prompt), ...pushTexts(prompt)].join("\n")
      assert.include(seen, "CHILD-A-OUT", "returned or pushed")
      assert.include(seen, "CHILD-B-OUT", "returned or pushed")
    }).pipe(Effect.provide(rpcExecutorLayer({ scriptTimeout: "1 second" }))),
  )
})

import { assert, describe, it } from "@effect/vitest"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpServer from "effect/http/HttpServer"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import type * as AiError from "effect/ai/AiError"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import type * as Prompt from "effect/ai/Prompt"
import type * as Response from "effect/ai/Response"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import * as Agent from "./Agent.ts"
import * as AgentExecutor from "./AgentExecutor.ts"

// =============================================================================
// Background bash tasks: completion pushes and lifecycle.
//
// These drive the real Agent loop and a real executor. When a background bash
// task exits, the next model call gets a user message
// `<task id="…" kind="bash" status="…" exitCode="…">output</task>`, unless the
// task was already reported by `stopTask`, `waitTasks` or a `taskOutput` call
// that saw its final status. Task IDs come from the executor's counter: "1",
// "2", ...
// =============================================================================

type Respond = (
  index: number,
) => Stream.Stream<Response.StreamPartEncoded, AiError.AiError>

const runAgent = (respond: Respond) =>
  Effect.gen(function* () {
    const executor = yield* AgentExecutor.AgentExecutor
    const prompts: Array<Prompt.Prompt> = []
    const languageModel = yield* LanguageModel.make({
      generateText: () => Effect.die("unexpected generateText call"),
      streamText: (providerOptions) => {
        const index = prompts.length
        prompts.push(providerOptions.prompt)
        return respond(index)
      },
    })
    const agent = yield* Agent.make.pipe(
      Effect.provideService(AgentExecutor.AgentExecutor, executor),
    )
    const exit = yield* agent.send({ prompt: "hello" }).pipe(
      Effect.flatMap((stream) =>
        stream.pipe(
          Stream.runDrain,
          Effect.as(""),
          Effect.catchTag("AgentFinished", (finished) =>
            Effect.succeed(finished.summary),
          ),
        ),
      ),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(LanguageModel.LanguageModel, languageModel),
          Layer.succeed(Model.ProviderName, "test-provider"),
          Layer.succeed(Model.ModelName, "test-model"),
          Agent.ConversationMode.layer(true),
        ),
      ),
      Effect.exit,
    )
    return { exit, prompts }
  }).pipe(Effect.scoped, Effect.timeout("5 seconds"))

// --- fixtures ----------------------------------------------------------------

const execute = (
  id: string,
  script: string,
): Stream.Stream<Response.StreamPartEncoded> =>
  Stream.make({
    type: "tool-call",
    id,
    name: "execute",
    params: { script },
  })

const text = (content: string): Stream.Stream<Response.StreamPartEncoded> =>
  Stream.make(
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: content },
    { type: "text-end", id: "t" },
  )

const messageText = (message: Prompt.Message): string =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")

/** The system message of the first model call. */
const systemPrompt = (prompts: ReadonlyArray<Prompt.Prompt>): string =>
  messageText(prompts[0]!.content[0]!)

/** The user messages in `prompt` that carry a completion push. */
const taskPushes = (prompt: Prompt.Prompt): Array<string> =>
  prompt.content.flatMap((message) => {
    if (message.role !== "user") return []
    const text = messageText(message)
    return text.includes("<task id=") ? [text] : []
  })

// --- executors ---------------------------------------------------------------

const localExecutorLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    return AgentExecutor.layerLocal({ directory })
  }),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)))

// Serves a fresh executor and connects an RPC client protocol to it.
const rpcProtocolLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const { protocol, httpEffect } =
      yield* RpcServer.makeProtocolWithHttpEffect()
    yield* Layer.build(
      AgentExecutor.layerRpcServer({ directory }).pipe(
        Layer.provide(Layer.succeed(RpcServer.Protocol, protocol)),
      ),
    )
    yield* HttpServer.serveEffect(httpEffect)
    return RpcClient.layerProtocolHttp({ url: "" })
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

const rpcExecutorLayer = AgentExecutor.layerRpc.pipe(
  Layer.provide(rpcProtocolLayer),
)

const executors = [
  ["local", localExecutorLayer],
  ["rpc", rpcExecutorLayer],
] as const

// --- tests -------------------------------------------------------------------

for (const [executorName, executorLayer] of executors) {
  // Each test gets its own executor, so task IDs start at "1".
  describe(`background bash tasks (${executorName} executor)`, () => {
    it.live(
      "a finished bash task is pushed once with its id, kind, status, exit code and output",
      () =>
        Effect.gen(function* () {
          const { exit, prompts } = yield* runAgent((index) => {
            switch (index) {
              case 0:
                // The script outlives the task, so it has exited before the
                // next model call.
                return execute(
                  "start",
                  `await bash({ command: "echo JOB-OUTPUT && exit 3", background: true })
await sleep(500)`,
                )
              case 1:
                return execute("again", `console.log("AGAIN")`)
              default:
                return text("done")
            }
          })

          assert.deepStrictEqual(exit, Exit.succeed("done"))
          assert.strictEqual(prompts.length, 3)
          const pushes = taskPushes(prompts[1]!)
          assert.strictEqual(pushes.length, 1, "pushed before the next call")
          assert.match(
            pushes[0]!,
            /^<task id="1" kind="bash" status="failed" exitCode="3">\s*JOB-OUTPUT\s*<\/task>$/,
          )
          assert.deepStrictEqual(
            taskPushes(prompts[2]!),
            pushes,
            "not pushed a second time",
          )
        }).pipe(Effect.provide(executorLayer)),
    )

    it.live(
      "a bash task whose final state stopTask, taskOutput, waitTasks or bash returned is not pushed",
      () =>
        Effect.gen(function* () {
          const { exit, prompts } = yield* runAgent((index) => {
            switch (index) {
              case 0:
                // Task 3 is never read, so it is the only push.
                return execute(
                  "start",
                  `await bash({ command: "sleep 30", background: true })
await bash({ command: "echo READ", background: true })
await bash({ command: "echo UNREAD", background: true })
await stopTask("1")
let task = await taskOutput("2")
while (task.status === "running") {
  await sleep(20)
  task = await taskOutput("2")
}
await bash({ command: "echo FOREGROUND" })
await waitTasks({ ids: [(await bash({ command: "echo WAITED", background: true })).id] })
await sleep(500)
console.log("SCRIPT" + "-DONE")`,
                )
              default:
                return text("done")
            }
          })

          assert.deepStrictEqual(exit, Exit.succeed("done"))
          assert.strictEqual(prompts.length, 2)
          const pushes = taskPushes(prompts[1]!)
          assert.strictEqual(pushes.length, 1)
          assert.match(
            pushes[0]!,
            /^<task id="3" kind="bash" status="completed" exitCode="0">\s*UNREAD\s*<\/task>$/,
          )
          assert.include(JSON.stringify(prompts[1]), "SCRIPT-DONE")
        }).pipe(Effect.provide(executorLayer)),
    )

    // Unlike a sub-agent, a running bash task such as a dev server never holds
    // the run open. The run timeout fails a run that waits for it.
    it.live(
      "a running bash task neither keeps an idle turn alive nor blocks taskComplete",
      () =>
        Effect.gen(function* () {
          const idle = yield* runAgent((index) =>
            index === 0
              ? execute(
                  "start",
                  `await bash({ command: "sleep 30", background: true })`,
                )
              : text("idle"),
          )
          assert.deepStrictEqual(idle.exit, Exit.succeed("idle"))
          assert.strictEqual(idle.prompts.length, 2)

          const completed = yield* runAgent((index) =>
            index === 0
              ? execute(
                  "complete",
                  `await bash({ command: "sleep 30", background: true })
await taskComplete("done")`,
                )
              : text("taskComplete was rejected"),
          )
          assert.deepStrictEqual(completed.exit, Exit.succeed("done"))
          assert.strictEqual(completed.prompts.length, 1)
        }).pipe(Effect.provide(executorLayer)),
    )
  })
}

// Clients and executor servers of different versions must keep working
// together.
describe("background bash tasks across versions", () => {
  it.live(
    "the prompt promises task pushes only when the executor sends them",
    () =>
      Effect.gen(function* () {
        const { current, capabilities } = yield* Effect.gen(function* () {
          const executor = yield* AgentExecutor.AgentExecutor
          return {
            current: yield* runAgent(() => text("done")),
            capabilities: yield* executor.capabilities,
          }
        }).pipe(Effect.provide(localExecutorLayer))
        assert.include(systemPrompt(current.prompts), '<task id="..."')

        // The current executor's tool typings without task pushes: what an
        // older client sees from a current server, or what a custom executor
        // that does not set `taskPushes` renders.
        const withoutTaskPushes = AgentExecutor.AgentExecutor.of({
          capabilities: Effect.succeed(
            new AgentExecutor.Capabilities({
              ...capabilities,
              taskPushes: false,
            }),
          ),
          execute: () => Stream.empty,
          executeUnsafe: () => Effect.die("executeUnsafe not implemented"),
        })
        const older = yield* runAgent(() => text("done")).pipe(
          Effect.provideService(AgentExecutor.AgentExecutor, withoutTaskPushes),
        )
        const olderPrompt = systemPrompt(older.prompts)
        assert.include(olderPrompt, "bash(", "the tool typings are included")
        assert.include(olderPrompt, '"taskOutput"')
        assert.notInclude(olderPrompt, "<task", "no push is promised")
      }),
  )

  // A client from before task pushes cannot decode a `Task` part, so one
  // would end its script with a defect.
  it.live("the server sends no Task parts to a client that did not ask", () =>
    Effect.gen(function* () {
      const client = yield* RpcClient.make(AgentExecutor.Rpcs)
      const { environment } = yield* client.capabilities()
      const parts = yield* client
        .execute({
          script: `await bash({ command: "true", background: true })`,
          environment,
          loopTools: [],
        })
        .pipe(Stream.runCollect)
      const tags = parts.map((part) => part._tag)
      assert.include(tags, "Environment", "the script ran")
      assert.notInclude(tags, "Task")
    }).pipe(Effect.scoped, Effect.provide(rpcProtocolLayer)),
  )
})

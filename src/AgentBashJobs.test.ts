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
// Background bash jobs: completion pushes.
//
// These drive the real Agent loop and a real executor. When a background job
// exits, the next model call gets a user message
// `<job id="…" status="…" exitCode="…">output</job>`, unless the job was
// already reported by `stopJob` or by a `jobOutput` call that saw its final
// status. Job IDs come from the executor's counter: "1", "2", ...
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
const jobPushes = (prompt: Prompt.Prompt): Array<string> =>
  prompt.content.flatMap((message) => {
    if (message.role !== "user") return []
    const text = messageText(message)
    return text.includes("<job id=") ? [text] : []
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
  // Each test gets its own executor, so job IDs start at "1".
  describe(`background bash jobs (${executorName} executor)`, () => {
    it.live(
      "a finished job is pushed once with its id, status, exit code and output",
      () =>
        Effect.gen(function* () {
          const { exit, prompts } = yield* runAgent((index) => {
            switch (index) {
              case 0:
                // The script outlives the job, so it has exited before the
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
          const pushes = jobPushes(prompts[1]!)
          assert.strictEqual(pushes.length, 1, "pushed before the next call")
          assert.match(
            pushes[0]!,
            /^<job id="1" status="failed" exitCode="3">\s*JOB-OUTPUT\s*<\/job>$/,
          )
          assert.deepStrictEqual(
            jobPushes(prompts[2]!),
            pushes,
            "not pushed a second time",
          )
        }).pipe(Effect.provide(executorLayer)),
    )

    it.live(
      "a job whose final state stopJob, jobOutput, waitJob or bash returned is not pushed",
      () =>
        Effect.gen(function* () {
          const { exit, prompts } = yield* runAgent((index) => {
            switch (index) {
              case 0:
                // Job 3 is never read, so it is the only push.
                return execute(
                  "start",
                  `await bash({ command: "sleep 30", background: true })
await bash({ command: "echo READ", background: true })
await bash({ command: "echo UNREAD", background: true })
await stopJob("1")
let job = await jobOutput("2")
while (job.status === "running") {
  await sleep(20)
  job = await jobOutput("2")
}
await bash({ command: "echo FOREGROUND" })
await waitJob({ id: (await bash({ command: "echo WAITED", background: true })).id })
await sleep(500)
console.log("SCRIPT" + "-DONE")`,
                )
              default:
                return text("done")
            }
          })

          assert.deepStrictEqual(exit, Exit.succeed("done"))
          assert.strictEqual(prompts.length, 2)
          const pushes = jobPushes(prompts[1]!)
          assert.strictEqual(pushes.length, 1)
          assert.match(
            pushes[0]!,
            /^<job id="3" status="completed" exitCode="0">\s*UNREAD\s*<\/job>$/,
          )
          assert.include(JSON.stringify(prompts[1]), "SCRIPT-DONE")
        }).pipe(Effect.provide(executorLayer)),
    )
  })
}

// Clients and executor servers of different versions must keep working
// together.
describe("background bash jobs across versions", () => {
  it.live(
    "the prompt promises job pushes only when the executor sends them",
    () =>
      Effect.gen(function* () {
        const { current, capabilities } = yield* Effect.gen(function* () {
          const executor = yield* AgentExecutor.AgentExecutor
          return {
            current: yield* runAgent(() => text("done")),
            capabilities: yield* executor.capabilities,
          }
        }).pipe(Effect.provide(localExecutorLayer))
        assert.include(systemPrompt(current.prompts), '<job id="..."')

        // The current executor's tool typings without job pushes: what an
        // older client sees from a current server, or what a custom executor
        // that does not set `jobPushes` renders.
        const withoutJobPushes = AgentExecutor.AgentExecutor.of({
          capabilities: Effect.succeed(
            new AgentExecutor.Capabilities({
              ...capabilities,
              jobPushes: false,
            }),
          ),
          execute: () => Stream.empty,
          executeUnsafe: () => Effect.die("executeUnsafe not implemented"),
        })
        const older = yield* runAgent(() => text("done")).pipe(
          Effect.provideService(AgentExecutor.AgentExecutor, withoutJobPushes),
        )
        const olderPrompt = systemPrompt(older.prompts)
        assert.include(olderPrompt, "bash(", "the tool typings are included")
        assert.include(olderPrompt, '"jobOutput"')
        assert.notInclude(olderPrompt, "<job", "no push is promised")
      }),
  )

  // A client from before job pushes cannot decode a `Job` part, so one would
  // end its script with a defect.
  it.live("the server sends no Job parts to a client that did not ask", () =>
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
      assert.notInclude(tags, "Job")
    }).pipe(Effect.scoped, Effect.provide(rpcProtocolLayer)),
  )
})

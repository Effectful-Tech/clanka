import { assert, describe, it } from "@effect/vitest"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpServer from "effect/http/HttpServer"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import type * as Prompt from "effect/ai/Prompt"
import type * as Response from "effect/ai/Response"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import * as Agent from "./Agent.ts"
import * as AgentExecutor from "./AgentExecutor.ts"
import { subagentsUnavailable } from "./AgentTools.ts"

// =============================================================================
// Caller-selected tools, instructions, skills and loop-side tools.
//
// These drive the real Agent loop against a real executor, local and RPC, with
// a scripted LanguageModel that answers the first call with one `execute`
// script. Every script ends with `taskComplete`, so a run makes exactly one
// model call; its system prompt and the final summary are what the tests
// observe. No SubagentModel is ever provided. The RPC executor talks over a
// real in-process HTTP server, so the tests run with the live clock.
// =============================================================================

type Mode = "local" | "rpc"

const modes: ReadonlyArray<Mode> = ["local", "rpc"]

interface ExecutorOptions {
  readonly excludeTools?:
    ReadonlyArray<"gh" | "webSearch" | "fetchMarkdown" | "delegate"> | undefined
}

// The executor's checkout carries instructions and a skill a caller may
// replace. Neither marker may leak into a prompt that replaced them.
const prepareDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped()
  yield* fs.writeFileString(
    path.join(directory, "AGENTS.md"),
    "EXECUTOR-AGENTS-MD",
  )
  const skillDir = path.join(directory, ".agents", "skills", "executor-skill")
  yield* fs.makeDirectory(skillDir, { recursive: true })
  yield* fs.writeFileString(
    path.join(skillDir, "SKILL.md"),
    "---\nname: executor-skill\ndescription: Executor skill\n---\nEXECUTOR-SKILL-CONTENT",
  )
  return directory
})

const localExecutor = (options: ExecutorOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const directory = yield* prepareDirectory
      return AgentExecutor.layerLocal({ directory, ...options })
    }),
  ).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  )

const rpcExecutor = (options: ExecutorOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const directory = yield* prepareDirectory
      const { protocol, httpEffect } =
        yield* RpcServer.makeProtocolWithHttpEffect()
      yield* Layer.build(
        AgentExecutor.layerRpcServer({ directory, ...options }).pipe(
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

const executorLayer = (mode: Mode, options: ExecutorOptions = {}) =>
  mode === "local" ? localExecutor(options) : rpcExecutor(options)

const systemText = (prompt: Prompt.Prompt): string =>
  prompt.content
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n")

// A script that does not reach `taskComplete` leads to a second model call;
// its tool result carries the script's output, including any thrown error.
const lastToolResult = (prompt: Prompt.Prompt): string => {
  const message = prompt.content.findLast((message) => message.role === "tool")
  if (message === undefined) return ""
  return message.content
    .map((part) => (part.type === "tool-result" ? String(part.result) : ""))
    .join("")
}

const toolCall = (script: string): Response.StreamPartEncoded => ({
  type: "tool-call",
  id: "call-1",
  name: "execute",
  params: { script },
})

/**
 * Runs one script through the Agent and returns the system prompt the model
 * saw and the summary passed to `taskComplete`.
 */
const runAgent = <LoopTools extends Toolkit.Any = never>(options: {
  readonly mode: Mode
  readonly executor?: ExecutorOptions | undefined
  readonly agent?: Agent.Options<LoopTools> | undefined
  readonly handlers?: Layer.Layer<Agent.LoopToolServices<LoopTools>> | undefined
  readonly script: string
}) =>
  Effect.gen(function* () {
    let system = ""
    let calls = 0
    const languageModel = yield* LanguageModel.make({
      generateText: () => Effect.die("unexpected generateText call"),
      streamText: (providerOptions) => {
        if (calls++ > 0) {
          return Stream.die(
            `the script did not call taskComplete: ${lastToolResult(providerOptions.prompt)}`,
          )
        }
        system = systemText(providerOptions.prompt)
        return Stream.make(toolCall(options.script))
      },
    })
    const modelLayer = Layer.mergeAll(
      Layer.succeed(LanguageModel.LanguageModel, languageModel),
      Layer.succeed(Model.ProviderName, "test-provider"),
      Layer.succeed(Model.ModelName, "test-model"),
    )
    const agent = yield* Agent.makeWith(options.agent ?? {})
    const summary = yield* agent.send({ prompt: "hello" }).pipe(
      Effect.flatMap(Stream.runDrain),
      Effect.as(""),
      Effect.catchTag("AgentFinished", (finished) =>
        Effect.succeed(finished.summary),
      ),
      Effect.provide(modelLayer),
    )
    return { system, summary }
  }).pipe(
    Effect.scoped,
    // The executor lives as long as the run, not just the Agent's creation.
    Effect.provide([
      executorLayer(options.mode, options.executor),
      options.handlers ?? Layer.empty,
    ]),
    Effect.timeout("4 seconds"),
  )

// --- loop-side tools, shaped like janitor's --------------------------------

const Finding = Schema.Struct({
  path: Schema.String,
  startLine: Schema.Finite,
  endLine: Schema.Finite,
  severity: Schema.Literals(["blocking", "nit"]),
  comment: Schema.String,
})

const ReviewTools = Toolkit.make(
  Tool.make("reportFinding", {
    description: "Report a review finding on a line range of the diff.",
    parameters: Finding,
    success: Schema.Struct({ id: Schema.Finite }),
    failure: Schema.String,
  }),
)

const notInDiff = (finding: typeof Finding.Type) =>
  `line ${finding.startLine} of ${finding.path} is not in the diff`

/**
 * Records findings on the loop side. Lines past 50 are rejected with a
 * message for the model.
 */
const reviewHandlers = (
  onCall: (finding: typeof Finding.Type) => Effect.Effect<void> = () =>
    Effect.void,
) => {
  const findings: Array<typeof Finding.Type> = []
  const handlers = ReviewTools.toLayer({
    reportFinding: (finding) =>
      Effect.gen(function* () {
        if (finding.startLine > 50) {
          return yield* Effect.fail(notInDiff(finding))
        }
        yield* onCall(finding)
        findings.push(finding)
        return { id: findings.length }
      }),
  })
  return { findings, handlers }
}

const report = (fields: string) =>
  `reportFinding({ path: "src/foo.ts", endLine: 9, severity: "nit", comment: "rename", ${fields} })`

// --- tests -------------------------------------------------------------------

for (const mode of modes) {
  describe(`caller-selected built-in tools (${mode} executor)`, () => {
    it.live(
      "left-out tools are not declared to the model and do not exist in scripts",
      () =>
        Effect.gen(function* () {
          const { system, summary } = yield* runAgent({
            mode,
            executor: {
              excludeTools: ["gh", "webSearch", "fetchMarkdown", "delegate"],
            },
            script: `const missing = [typeof gh, typeof webSearch, typeof fetchMarkdown, typeof delegate, typeof waitAgents].join(",")
let call
try {
  await gh(["pr", "view"])
  call = "called"
} catch (error) {
  call = "failed"
}
await taskComplete(missing + " " + call)`,
          })
          assert.strictEqual(
            summary,
            "undefined,undefined,undefined,undefined,undefined failed",
          )
          assert.notMatch(
            system,
            /\b(gh|webSearch|fetchMarkdown|delegate|waitAgents|messageAgent|stopAgent|listAgents)\b/,
          )
          assert.include(system, "declare function readFile(")
          assert.include(system, "declare function taskComplete(")
        }),
    )
  })

  describe(`caller-supplied instructions (${mode} executor)`, () => {
    it.live("replace the executor's AGENTS.md, or remove it", () =>
      Effect.gen(function* () {
        const script = 'await taskComplete("ok")'
        const byDefault = yield* runAgent({ mode, script })
        assert.include(byDefault.system, "EXECUTOR-AGENTS-MD")

        const replaced = yield* runAgent({
          mode,
          agent: { instructions: Option.some("CALLER-INSTRUCTIONS") },
          script,
        })
        assert.include(replaced.system, "CALLER-INSTRUCTIONS")
        assert.notInclude(replaced.system, "EXECUTOR-AGENTS-MD")

        const removed = yield* runAgent({
          mode,
          agent: { instructions: Option.none() },
          script,
        })
        assert.notInclude(removed.system, "EXECUTOR-AGENTS-MD")
        assert.notInclude(removed.system, "CALLER-INSTRUCTIONS")
      }),
    )
  })

  describe(`caller-supplied skills (${mode} executor)`, () => {
    it.live(
      "replace the executor's skills and are read from the caller, or remove them",
      () =>
        Effect.gen(function* () {
          const byDefault = yield* runAgent({
            mode,
            script: 'await taskComplete("ok")',
          })
          assert.include(byDefault.system, "executor-skill")

          const replaced = yield* runAgent({
            mode,
            agent: {
              skills: [
                {
                  name: "caller-skill",
                  description: "Caller skill",
                  content: "CALLER-SKILL-CONTENT",
                },
              ],
            },
            script: 'await taskComplete(await readSkill("caller-skill"))',
          })
          assert.strictEqual(replaced.summary, "CALLER-SKILL-CONTENT")
          assert.include(replaced.system, "caller-skill: Caller skill")
          assert.notInclude(replaced.system, "executor-skill")
          assert.notInclude(replaced.system, "CALLER-SKILL-CONTENT")

          const removed = yield* runAgent({
            mode,
            agent: { skills: [] },
            script: 'await taskComplete("ok")',
          })
          assert.notInclude(removed.system, "# Skills")
          assert.notInclude(removed.system, "executor-skill")
        }),
    )
  })

  describe(`loop-side tools (${mode} executor)`, () => {
    it.live(
      "are declared to the model, decoded on the loop and answer the script",
      () =>
        Effect.gen(function* () {
          const { findings, handlers } = reviewHandlers()
          const { system, summary } = yield* runAgent({
            mode,
            agent: { loopTools: ReviewTools },
            handlers,
            script: `const result = await ${report("startLine: 3")}
await taskComplete(JSON.stringify(result))`,
          })
          assert.strictEqual(summary, '{"id":1}')
          assert.deepStrictEqual(findings, [
            {
              path: "src/foo.ts",
              startLine: 3,
              endLine: 9,
              severity: "nit",
              comment: "rename",
            },
          ])
          assert.include(system, "declare function reportFinding(")
          assert.include(
            system,
            "Report a review finding on a line range of the diff.",
          )
        }),
    )

    it.live("invalid arguments never reach the handler", () =>
      Effect.gen(function* () {
        const { findings, handlers } = reviewHandlers()
        const { summary } = yield* runAgent({
          mode,
          agent: { loopTools: ReviewTools },
          handlers,
          script: `try {
  await ${report('startLine: "three"')}
  await taskComplete("called")
} catch (error) {
  await taskComplete("rejected: " + error.message)
}`,
        })
        // The rejection names the tool and the argument, so the model can
        // fix the call.
        assert.match(summary, /^rejected: /)
        assert.include(summary, "reportFinding")
        assert.include(summary, "startLine")
        assert.deepStrictEqual(findings, [])
      }),
    )

    it.live("a handler can reject a call with a message for the model", () =>
      Effect.gen(function* () {
        const { handlers } = reviewHandlers()
        const { summary } = yield* runAgent({
          mode,
          agent: { loopTools: ReviewTools },
          handlers,
          script: `try {
  await ${report("startLine: 88")}
  await taskComplete("called")
} catch (error) {
  await taskComplete("rejected: " + error.message)
}`,
        })
        assert.strictEqual(
          summary,
          "rejected: line 88 of src/foo.ts is not in the diff",
        )
      }),
    )

    it.live("concurrent calls from one script run at the same time", () =>
      Effect.gen(function* () {
        // Every call waits until all three have arrived: serialized calls
        // would never open the latch.
        const allArrived = yield* Latch.make(false)
        let arrived = 0
        const { handlers } = reviewHandlers(() =>
          Effect.gen(function* () {
            if (++arrived === 3) yield* allArrived.open
            yield* allArrived.await
          }),
        )
        const { summary } = yield* runAgent({
          mode,
          agent: { loopTools: ReviewTools },
          handlers,
          script: `const results = await Promise.all(
  [1, 2, 3].map((line) => ${report("startLine: line")}),
)
await taskComplete(results.map((result) => result.id).sort().join(","))`,
        })
        assert.strictEqual(summary, "1,2,3")
      }),
    )

    it.live("interrupting the run interrupts in-flight calls", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const interrupted = yield* Deferred.make<void>()
        const { handlers } = reviewHandlers(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
        )
        const fiber = yield* Effect.forkChild(
          runAgent({
            mode,
            agent: { loopTools: ReviewTools },
            handlers,
            script: `await ${report("startLine: 3")}
await taskComplete("unreachable")`,
          }),
        )
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        yield* Deferred.await(interrupted).pipe(Effect.timeout("2 seconds"))
      }),
    )
  })

  describe(`loop-side tools at the executor (${mode} executor)`, () => {
    it.live("concurrent scripts call them at the same time", () =>
      Effect.gen(function* () {
        const bothArrived = yield* Latch.make(false)
        let arrived = 0
        const loopTools: AgentExecutor.LoopToolHandlers = {
          echo: (params) =>
            Effect.gen(function* () {
              if (++arrived === 2) yield* bothArrived.open
              yield* bothArrived.await
              return params
            }),
        }
        const run = (script: string) =>
          Effect.gen(function* () {
            const executor = yield* AgentExecutor.AgentExecutor
            return yield* executor
              .execute({
                script,
                onTaskComplete: () => Effect.void,
                onImage: () => Effect.void,
                subagents: subagentsUnavailable,
                loopTools,
              })
              .pipe(Stream.mkString)
          })
        const outputs = yield* Effect.all(
          [
            run('console.log("first:" + (await echo("one")))'),
            run('console.log("second:" + (await echo("two")))'),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.provide(executorLayer(mode)),
          Effect.scoped,
          Effect.timeout("4 seconds"),
        )
        assert.isTrue(outputs[0].endsWith("first:one\n"))
        assert.isTrue(outputs[1].endsWith("second:two\n"))
      }),
    )
  })
}

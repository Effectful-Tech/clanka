import { assert, describe, it } from "@effect/vitest"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
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
import * as AgentSkills from "./AgentSkills.ts"
import { type ExcludableTool, subagentsUnavailable } from "./AgentTools.ts"

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
  readonly excludeTools?: ReadonlyArray<ExcludableTool> | undefined
  readonly tools?: Toolkit.Any | undefined
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

// A loop-side tool that rejects lines past 50, as janitor rejects lines that
// are not in the diff.
const Report = Toolkit.make(
  Tool.make("report", {
    description: "Report a finding on a line of the diff.",
    parameters: Schema.Struct({ line: Schema.Finite }),
    success: Schema.Struct({ line: Schema.Finite }),
    failure: Schema.String,
  }),
)

const reportHandlers = (onCall: (line: number) => Effect.Effect<void>) =>
  Report.toLayer({
    report: ({ line }) =>
      onCall(line).pipe(
        Effect.andThen(
          line > 50
            ? Effect.fail(`line ${line} is not in the diff`)
            : Effect.succeed({ line }),
        ),
      ),
  })

// Runs a script on the executor directly, below the Agent.
const execute = (
  script: string,
  loopTools?: AgentExecutor.LoopToolHandlers | undefined,
) =>
  Effect.gen(function* () {
    const executor = yield* AgentExecutor.AgentExecutor
    const { environment } = yield* executor.capabilities
    return yield* executor
      .execute({
        script,
        environment,
        onEnvironment: () => Effect.void,
        onTaskComplete: () => Effect.void,
        onImage: () => Effect.void,
        subagents: subagentsUnavailable,
        loopTools,
      })
      .pipe(Stream.mkString)
  })

// --- tests -------------------------------------------------------------------

// Where the RPC executor takes its own path.
for (const mode of modes) {
  describe(`${mode} executor`, () => {
    it.live("left-out tools are not offered to the model or the script", () =>
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
      }),
    )

    it.live("a caller tool replaces a left-out built-in of the same name", () =>
      Effect.gen(function* () {
        let calls = 0
        const CallerTools = Toolkit.make(
          Tool.make("readFile", {
            parameters: Schema.Struct({ path: Schema.String }),
            success: Schema.String,
          }),
        )
        const output = yield* execute(
          'console.log(await readFile({ path: "AGENTS.md" }))',
        ).pipe(
          Effect.provide(
            executorLayer(mode, {
              excludeTools: ["readFile"],
              tools: CallerTools,
            }).pipe(
              Layer.provide(
                CallerTools.toLayer({
                  readFile: () =>
                    Effect.sync(() => {
                      calls++
                      return "CALLER"
                    }),
                }),
              ),
            ),
          ),
          Effect.scoped,
          Effect.timeout("4 seconds"),
        )
        assert.isTrue(output.endsWith("CALLER\n"))
        assert.strictEqual(calls, 1)
      }),
    )

    it.live(
      "loop-side tools are declared, decoded on the loop and answer the script",
      () =>
        Effect.gen(function* () {
          // The two valid calls wait for each other: serialized calls never
          // open the latch.
          const bothArrived = yield* Latch.make(false)
          const lines: Array<number> = []
          const { system, summary } = yield* runAgent({
            mode,
            agent: { loopTools: Report },
            handlers: reportHandlers((line) =>
              Effect.gen(function* () {
                if (lines.push(line) === 2) yield* bothArrived.open
                yield* bothArrived.await
              }),
            ),
            script: `const message = (call) => call.then(() => "called", (error) => error.message)
await taskComplete(JSON.stringify({
  result: await Promise.all([report({ line: 3 }), report({ line: 4 })]),
  invalid: await message(report({ line: "three" })),
  rejected: await message(report({ line: 88 })),
}))`,
          })
          const { result, invalid, rejected } = JSON.parse(summary)
          assert.deepStrictEqual(result, [{ line: 3 }, { line: 4 }])
          // The rejection names the tool and the argument, and the handler
          // never sees the call.
          assert.include(invalid, "report")
          assert.include(invalid, "line")
          assert.strictEqual(rejected, "line 88 is not in the diff")
          assert.sameMembers(lines, [3, 4, 88])
          assert.include(system, "declare function report(")
          assert.include(system, "Report a finding on a line of the diff.")
        }),
    )

    it.live("interrupting the run interrupts in-flight loop-side calls", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const interrupted = yield* Deferred.make<void>()
        const fiber = yield* Effect.forkChild(
          runAgent({
            mode,
            agent: { loopTools: Report },
            handlers: reportHandlers(() =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() =>
                  Deferred.succeed(interrupted, undefined),
                ),
              ),
            ),
            script: "await report({ line: 3 })",
          }),
        )
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        yield* Deferred.await(interrupted).pipe(Effect.timeout("2 seconds"))
      }),
    )
  })
}

describe("rpc executor", () => {
  it.live("loop-side calls run concurrently within and across scripts", () =>
    Effect.gen(function* () {
      // Every call waits for all four: serialized calls never open the latch.
      const allArrived = yield* Latch.make(false)
      let arrived = 0
      const loopTools: AgentExecutor.LoopToolHandlers = {
        echo: (params) =>
          Effect.gen(function* () {
            if (++arrived === 4) yield* allArrived.open
            yield* allArrived.await
            return params
          }),
      }
      const outputs = yield* Effect.all(
        [
          execute(
            'console.log((await Promise.all([echo("a1"), echo("a2")])).join())',
            loopTools,
          ),
          execute(
            'console.log((await Promise.all([echo("b1"), echo("b2")])).join())',
            loopTools,
          ),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.provide(executorLayer("rpc")),
        Effect.scoped,
        Effect.timeout("4 seconds"),
      )
      assert.isTrue(outputs[0].endsWith("a1,a2\n"))
      assert.isTrue(outputs[1].endsWith("b1,b2\n"))
    }),
  )
})

// Decided by the Agent from the executor's capabilities, whatever the
// transport.
describe("agent", () => {
  it.live("a left-out tool is not mentioned anywhere in the prompt", () =>
    Effect.gen(function* () {
      // Each is named outside its own declaration: the delegate bullet, the
      // applyPatch hint and the executor's skills catalog.
      const { system, summary } = yield* runAgent({
        mode: "local",
        executor: { excludeTools: ["waitAgents", "applyPatch", "readFile"] },
        script:
          "await taskComplete([typeof waitAgents, typeof applyPatch, typeof readFile].join())",
      })
      assert.strictEqual(summary, "undefined,undefined,undefined")
      assert.notMatch(system, /\b(waitAgents|applyPatch|readFile)\b/)
      assert.include(system, "declare function delegate(")
    }),
  )

  it.live("caller instructions and skills replace the executor's", () =>
    Effect.gen(function* () {
      const byDefault = yield* runAgent({
        mode: "local",
        script: 'await taskComplete("ok")',
      })
      assert.include(byDefault.system, "EXECUTOR-AGENTS-MD")
      assert.include(byDefault.system, "executor-skill")

      const replaced = yield* runAgent({
        mode: "local",
        agent: {
          instructions: Option.some("CALLER-INSTRUCTIONS"),
          skills: [
            new AgentSkills.ProvidedSkill({
              name: "caller-skill",
              description: "Caller skill",
              content: "CALLER-SKILL-CONTENT",
            }),
          ],
        },
        script: 'await taskComplete(await readSkill("caller-skill"))',
      })
      assert.strictEqual(replaced.summary, "CALLER-SKILL-CONTENT")
      assert.include(replaced.system, "CALLER-INSTRUCTIONS")
      assert.include(replaced.system, "caller-skill: Caller skill")
      assert.notInclude(replaced.system, "EXECUTOR-AGENTS-MD")
      assert.notInclude(replaced.system, "executor-skill")
      // Skill content is only read on demand.
      assert.notInclude(replaced.system, "CALLER-SKILL-CONTENT")

      const removed = yield* runAgent({
        mode: "local",
        agent: { instructions: Option.none(), skills: [] },
        script: 'await taskComplete("ok")',
      })
      assert.notInclude(removed.system, "EXECUTOR-AGENTS-MD")
      assert.notInclude(removed.system, "# Skills")
    }),
  )

  it.live("a loop-side tool cannot shadow a built-in tool", () =>
    Effect.gen(function* () {
      const Shadow = Toolkit.make(
        Tool.make("readFile", { parameters: Schema.String }),
      )
      const result = yield* Agent.makeWith({ loopTools: Shadow }).pipe(
        Effect.as("built"),
        Effect.scoped,
        Effect.provide([
          executorLayer("local"),
          Shadow.toLayer({ readFile: () => Effect.void }),
        ]),
        Effect.catchDefect((defect) => Effect.succeed(String(defect))),
      )
      assert.include(result, "readFile")
      assert.notStrictEqual(result, "built")
    }),
  )

  it.live("a caller readSkill runs when no skills are provided", () =>
    Effect.gen(function* () {
      const CallerTools = Toolkit.make(
        Tool.make("readSkill", {
          parameters: Schema.String,
          success: Schema.String,
        }),
      )
      const { summary } = yield* runAgent({
        mode: "local",
        agent: { loopTools: CallerTools, skills: [] },
        handlers: CallerTools.toLayer({
          readSkill: (name) => Effect.succeed(`CALLER:${name}`),
        }),
        script: 'await taskComplete(await readSkill("anything"))',
      })
      assert.strictEqual(summary, "CALLER:anything")
    }),
  )
})

describe("executor capabilities", () => {
  // Loop and executor are upgraded together, so an executor that does not
  // report its tools is rejected rather than assumed to offer all of them.
  it.effect("require the tools the executor offers", () =>
    Effect.gen(function* () {
      const codec = Schema.toCodecJson(AgentExecutor.Capabilities)
      const encoded = yield* Schema.encodeEffect(codec)(
        new AgentExecutor.Capabilities({
          toolsDts: "",
          environment: new AgentExecutor.ExecutionEnvironment({
            cwd: "/",
            baseline: [],
            seen: [],
          }),
          instructions: Option.none(),
          supportsSearch: false,
          tools: ["readFile"],
          skills: [],
        }),
      )
      const { tools: _, ...older } = encoded as Record<string, Schema.Json>
      const exit = yield* Effect.exit(Schema.decodeUnknownEffect(codec)(older))
      assert.isTrue(Exit.isFailure(exit))
    }),
  )
})

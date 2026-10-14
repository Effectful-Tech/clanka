import { assert, describe, it } from "@effect/vitest"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpServer from "effect/http/HttpServer"
import * as Layer from "effect/Layer"
import * as MutableRef from "effect/MutableRef"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type * as AiError from "effect/ai/AiError"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import * as Prompt from "effect/ai/Prompt"
import type * as Response from "effect/ai/Response"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import * as NodeFs from "node:fs"
import * as NodePath from "node:path"
import * as Agent from "./Agent.ts"
import * as AgentExecutor from "./AgentExecutor.ts"
import * as Compaction from "./Compaction.ts"

// =============================================================================
// AGENTS.md and skills found after `changeDirectory` reach the model as
// `<environment-update>` user messages, while the system prompt stays the
// same. These drive the real Agent loop and a real executor over a project
// with its own instructions at the root and in `pkg/`.
// =============================================================================

const skill = (name: string) => `---
name: ${name}
description: The ${name} skill.
---

Instructions for ${name}.
`

const projectFiles: Record<string, string> = {
  "AGENTS.md": "ROOT-RULES",
  ".agents/skills/root-skill/SKILL.md": skill("root-skill"),
  "pkg/AGENTS.md": "PKG-RULES",
  "pkg/.agents/skills/pkg-skill/SKILL.md": skill("pkg-skill"),
}

const makeProject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  for (const [file, content] of Object.entries(projectFiles)) {
    const target = NodePath.join(directory, file)
    yield* fs.makeDirectory(NodePath.dirname(target), { recursive: true })
    yield* fs.writeFileString(target, content)
  }
  return directory
})

const executors = {
  local: Layer.unwrap(
    Effect.map(makeProject, (directory) =>
      AgentExecutor.layerLocal({ directory }),
    ),
  ).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ),
  rpc: Layer.unwrap(
    Effect.gen(function* () {
      const directory = yield* makeProject
      const { protocol, httpEffect } =
        yield* RpcServer.makeProtocolWithHttpEffect()
      yield* Layer.build(
        AgentExecutor.layerRpcServer({ directory }).pipe(
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
  ),
}

// --- harness -----------------------------------------------------------------

interface Call {
  readonly prompt: Prompt.Prompt
  readonly isSummarizer: boolean
}

type Respond = (
  call: Call,
) => Stream.Stream<Response.StreamPartEncoded, AiError.AiError>

// An Agent on the provided executor and a scripted model that records every
// call. The summarizer is the call without tools.
const makeAgent = (options: {
  readonly respond: Respond
  readonly compaction?: Partial<Compaction.CompactionConfigService> | undefined
}) =>
  Effect.gen(function* () {
    const calls: Array<Call> = []
    const record = (prompt: Prompt.Prompt, tools: ReadonlyArray<unknown>) => {
      const call: Call = { prompt, isSummarizer: tools.length === 0 }
      calls.push(call)
      return options.respond(call)
    }
    const languageModel = yield* LanguageModel.make({
      generateText: (providerOptions) =>
        record(providerOptions.prompt, providerOptions.tools).pipe(
          Stream.runCollect,
          Effect.map((parts): Array<Response.PartEncoded> => [
            {
              type: "text",
              text: parts
                .flatMap((part) =>
                  part.type === "text-delta" ? [part.delta] : [],
                )
                .join(""),
            },
            ...parts.filter((part) => part.type === "finish"),
          ]),
        ),
      streamText: (providerOptions) =>
        record(providerOptions.prompt, providerOptions.tools),
    })
    const modelLayer = Layer.mergeAll(
      Layer.succeed(LanguageModel.LanguageModel, languageModel),
      Layer.succeed(Model.ProviderName, "test-provider"),
      Layer.succeed(Model.ModelName, "test-model"),
    )
    const agent = yield* Agent.make
    const send = (prompt: string) =>
      agent.send({ prompt }).pipe(
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
            modelLayer,
            Agent.ConversationMode.layer(true),
            Agent.layerSubagentModel(modelLayer),
            Compaction.CompactionConfig.layer(options.compaction ?? {}),
          ),
        ),
        Effect.scoped,
        Effect.exit,
      )
    return { agent, calls, send }
  })

// --- fixtures ----------------------------------------------------------------

let callId = 0
const toolCall = (script: string): Response.StreamPartEncoded => ({
  type: "tool-call",
  id: `call-${callId++}`,
  name: "execute",
  params: { script },
})

const text = (content: string): Array<Response.StreamPartEncoded> => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: content },
  { type: "text-end", id: "t" },
]

const finish = (
  contextTokens: number,
  reason: "stop" | "tool-calls" = "tool-calls",
): Response.StreamPartEncoded => ({
  type: "finish",
  reason,
  usage: {
    inputTokens: { total: contextTokens },
    outputTokens: { total: 10 },
  },
})

const messageText = (message: Prompt.Message): string =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")

const isChild = (call: Call) =>
  call.prompt.content.some(
    (message) =>
      message.role === "user" && messageText(message).includes("TASK-CHILD"),
  )

const environmentUpdates = (prompt: Prompt.Prompt): Array<string> =>
  prompt.content.flatMap((message) => {
    if (message.role !== "user") return []
    const content = messageText(message)
    return content.includes("<environment-update") ? [content] : []
  })

const encodePrompt = Schema.encodeSync(Prompt.Prompt)
const systemJson = (prompt: Prompt.Prompt) =>
  JSON.stringify(
    encodePrompt(prompt).content.filter((message) => message.role === "system"),
  )
const conversationJson = (prompt: Prompt.Prompt) =>
  JSON.stringify(
    encodePrompt(prompt).content.filter((message) => message.role !== "system"),
  )

const filler = (word: string, n: number) =>
  (word + " ").repeat(Math.ceil(n / (word.length + 1))).slice(0, n)

// Two earlier turns of about 7.5k tokens each, so there is something to
// summarize.
const fatHistory = Prompt.fromMessages(
  [1, 2].flatMap((n) => [
    Prompt.makeMessage("user", {
      content: [Prompt.makePart("text", { text: `Read log ${n}` })],
    }),
    Prompt.makeMessage("assistant", {
      content: [
        Prompt.makePart("tool-call", {
          id: `old-${n}`,
          name: "execute",
          params: { script: `await readFile({ path: "${n}.log" })` },
          providerExecuted: false,
        }),
      ],
    }),
    Prompt.makeMessage("tool", {
      content: [
        Prompt.makePart("tool-result", {
          id: `old-${n}`,
          name: "execute",
          isFailure: false,
          result: filler("log", 30_000),
          providerExecuted: false,
        }),
      ],
    }),
  ]),
)

// --- tests -------------------------------------------------------------------

for (const [mode, executorLayer] of Object.entries(executors)) {
  describe(`environment updates (${mode} executor)`, () => {
    it.live(
      "a cd sends only the new instructions and skills, once, with the same system prompt",
      () =>
        Effect.gen(function* () {
          let rootCalls = 0
          const { calls, send } = yield* makeAgent({
            respond: (call) => {
              if (isChild(call)) {
                return Stream.make(toolCall(`await taskComplete("child done")`))
              }
              switch (rootCalls++) {
                case 0:
                  return Stream.make(toolCall(`await changeDirectory("pkg")`))
                case 1:
                  return Stream.make(toolCall(`await changeDirectory("..")`))
                case 2:
                  return Stream.make(toolCall(`await changeDirectory("pkg")`))
                case 3:
                  return Stream.make(
                    toolCall(`await delegate({ prompt: "TASK-CHILD" })`),
                  )
                default:
                  return Stream.fromIterable(text("done"))
              }
            },
          })
          const exit = yield* send("hello")

          assert.deepStrictEqual(exit, Exit.succeed("done"))
          const root = calls.filter((call) => !isChild(call))
          assert.strictEqual(root.length, 5)
          for (const call of root) {
            assert.strictEqual(
              systemJson(call.prompt),
              systemJson(root[0]!.prompt),
              "the system prompt never changes",
            )
          }

          const afterCd = root[1]!.prompt
          const updates = environmentUpdates(afterCd)
          assert.strictEqual(updates.length, 1)
          assert.include(updates[0], "PKG-RULES")
          assert.include(updates[0], "pkg-skill")
          assert.notInclude(updates[0], "ROOT-RULES")
          assert.notInclude(updates[0], "root-skill")
          const updateIndex = afterCd.content.findIndex(
            (message) =>
              message.role === "user" &&
              messageText(message).includes("<environment-update"),
          )
          assert.isAbove(
            updateIndex,
            afterCd.content.findLastIndex((message) => message.role === "tool"),
            "the update follows the tool result",
          )

          assert.strictEqual(
            environmentUpdates(root[4]!.prompt).length,
            1,
            "leaving and entering pkg again sends nothing new",
          )

          const child = calls.find(isChild)
          assert.isDefined(child)
          assert.include(
            JSON.stringify(encodePrompt(child!.prompt)),
            "PKG-RULES",
            "a delegate started after the cd sees pkg's instructions",
          )
        }).pipe(
          Effect.scoped,
          Effect.timeout("4 seconds"),
          Effect.provide(executorLayer),
        ),
    )

    it.live("the instructions are present once after compaction", () =>
      Effect.gen(function* () {
        let rootCalls = 0
        const { agent, calls, send } = yield* makeAgent({
          compaction: {
            contextWindow: 20_000,
            reserveTokens: 4_000,
            keepRecentTokens: 9_000,
          },
          respond: (call) => {
            if (call.isSummarizer) {
              return Stream.fromIterable([
                ...text("EARLIER-WORK-SUMMARY"),
                finish(6_000, "stop"),
              ])
            }
            return rootCalls++ === 0
              ? // Usage over the threshold compacts before the next call.
                Stream.make(
                  toolCall(`await changeDirectory("pkg")`),
                  finish(17_000),
                )
              : Stream.fromIterable([...text("done"), finish(9_000, "stop")])
          },
        })
        MutableRef.set(agent.history, fatHistory)
        const exit = yield* send("continue")

        assert.deepStrictEqual(exit, Exit.succeed("done"))
        assert.isTrue(
          calls.some((call) => call.isSummarizer),
          "compaction ran",
        )
        const last = calls.at(-1)!.prompt
        assert.include(conversationJson(last), "EARLIER-WORK-SUMMARY")
        assert.strictEqual(
          conversationJson(last).split("PKG-RULES").length - 1,
          1,
          "pkg's instructions appear exactly once",
        )
      }).pipe(
        Effect.scoped,
        Effect.timeout("4 seconds"),
        Effect.provide(executorLayer),
      ),
    )

    // The update for an interrupted script never reaches the history, so its
    // instructions must still be sent with the next script.
    it.live("instructions found by an interrupted script reach the model", () =>
      Effect.gen(function* () {
        const executor = yield* AgentExecutor.AgentExecutor
        const { environment } = yield* executor.capabilities
        const marker = NodePath.join(environment.cwd, "pkg", "changed")
        let rootCalls = 0
        const { calls, send } = yield* makeAgent({
          respond: () => {
            switch (rootCalls++) {
              case 0:
                return Stream.make(
                  toolCall(`await changeDirectory("pkg")
await writeFile({ path: "changed", content: "" })
await sleep(60000)`),
                )
              case 1:
                return Stream.make(toolCall(`console.log("next")`))
              default:
                return Stream.fromIterable(text("done"))
            }
          },
        })

        const first = yield* Effect.forkScoped(send("start"))
        while (!NodeFs.existsSync(marker)) {
          yield* Effect.sleep("10 millis")
        }
        yield* Fiber.interrupt(first)
        const exit = yield* send("continue")

        assert.deepStrictEqual(exit, Exit.succeed("done"))
        assert.strictEqual(calls.length, 3)
        assert.isTrue(
          environmentUpdates(calls[2]!.prompt).some((update) =>
            update.includes("PKG-RULES"),
          ),
          "pkg's instructions are sent after the next script",
        )
      }).pipe(
        Effect.scoped,
        Effect.timeout("4 seconds"),
        Effect.provide(executorLayer),
      ),
    )
  })
}

import { assert, describe, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import type * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Queue from "effect/Queue"
import * as Schedule from "effect/Schedule"
import * as Sink from "effect/Sink"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Prompt from "effect/ai/Prompt"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import type * as Response from "effect/ai/Response"
import * as Acp from "./Acp.ts"
import * as Agent from "./Agent.ts"
import * as AgentExecutor from "./AgentExecutor.ts"
import * as Compaction from "./Compaction.ts"
import { listenHttp, makeFakeServer, text } from "./fixtures/McpFakeServer.ts"

type Message = {
  readonly id?: number
  readonly method?: string
  readonly result?: any
  readonly error?: { readonly code: number; readonly message: string }
  readonly params?: any
}

const capabilities = new AgentExecutor.Capabilities({
  toolsDts: "",
  environment: new AgentExecutor.ExecutionEnvironment({
    cwd: "/",
    baseline: [],
    seen: [],
  }),
  instructions: Option.none(),
  supportsSearch: false,
  tools: [],
  skills: [],
})

const executor = AgentExecutor.AgentExecutor.of({
  capabilities: Effect.succeed(capabilities),
  execute: () => Stream.make("script output"),
  executeUnsafe: () => Effect.die("executeUnsafe not implemented"),
})

// A fresh executor per server, like the CLI builds one per session.
const localExecutor = (directory: string) =>
  Layer.build(
    AgentExecutor.layerLocal({ directory }).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  ).pipe(
    Effect.map((context) => Context.get(context, AgentExecutor.AgentExecutor)),
  )

const makeServer = (
  streamText: Parameters<typeof LanguageModel.make>[0]["streamText"],
  agentExecutor = executor,
  onMakeModel?: (modelId: string, thoughtLevel: string) => void,
  availableModels?: Acp.Options<never, never>["availableModels"],
  supportsFastMode?: Acp.Options<never, never>["supportsFastMode"],
) =>
  Effect.gen(function* () {
    const sent: Array<Message> = []
    const languageModel = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText,
    })
    const modelLayer = Layer.mergeAll(
      Layer.succeed(LanguageModel.LanguageModel, languageModel),
      Layer.succeed(Model.ProviderName, "test"),
      Layer.succeed(Model.ModelName, "model"),
    )
    const server = yield* Acp.make({
      version: "test",
      defaultModel: "test:model",
      defaultThoughtLevel: "medium",
      send: (message) =>
        Effect.sync(() => {
          sent.push(message as Message)
        }),
      makeAgent: () =>
        Agent.make.pipe(
          Effect.provideService(AgentExecutor.AgentExecutor, agentExecutor),
        ),
      makeModel: (modelId, thoughtLevel) => {
        onMakeModel?.(modelId, thoughtLevel)
        return modelId === "test:model" || modelId === "other:model"
          ? Option.some(
              Layer.merge(modelLayer, Agent.layerSubagentModel(modelLayer)),
            )
          : Option.none()
      },
      availableModels,
      supportsFastMode,
    })
    const request = (id: number, method: string, params?: unknown) =>
      server
        .handle(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
        .pipe(Effect.map(() => sent.find((m) => m.id === id)!))
    const notify = (method: string, params?: unknown) =>
      server.handle(JSON.stringify({ jsonrpc: "2.0", method, params }))
    const updates = (sessionId: string) =>
      sent
        .filter(
          (m) =>
            m.method === "session/update" && m.params.sessionId === sessionId,
        )
        .map((m) => m.params.update)
    return { sent, request, notify, updates }
  })

const parts = (
  ...items: ReadonlyArray<Response.StreamPartEncoded>
): Stream.Stream<Response.StreamPartEncoded> => Stream.fromIterable(items)

const assistantSays = (text: string) =>
  parts(
    { type: "text-start", id: "1" },
    { type: "text-delta", id: "1", delta: text },
    { type: "text-end", id: "1" },
  )

// A model that runs `script` once, then answers "done".
const runsScript = (script: string) => {
  let calls = 0
  return () =>
    calls++ === 0
      ? parts({
          type: "tool-call",
          id: "call-1",
          name: "execute",
          params: { script },
        })
      : assistantSays("done")
}

const callsExecute = parts({
  type: "tool-call",
  id: "call-1",
  name: "execute",
  params: { script: "work" },
})

// An executor whose script signals `started`, then runs until `release`.
// With `completesTask` it calls taskComplete first.
const gatedScript = (options?: { readonly completesTask?: boolean }) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const gated = AgentExecutor.AgentExecutor.of({
      ...executor,
      execute: ({ onTaskComplete }) =>
        Stream.fromEffect(
          Effect.gen(function* () {
            if (options?.completesTask) {
              yield* Effect.ignore(onTaskComplete("finished"))
            }
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            return "script output"
          }),
        ),
    })
    return { started, release, executor: gated }
  })

const message = (role: "user" | "assistant", text: string) =>
  Prompt.makeMessage(role, {
    content: [Prompt.makePart("text", { text })],
  })

const withStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Layer.merge(
        KeyValueStore.layerMemory,
        Agent.ConversationMode.layer(true),
      ),
    ),
  )

describe("Acp", () => {
  it.effect("runs a prompt turn", () =>
    withStore(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* makeServer(() => assistantSays("hi there"))

          const init = yield* server.request(1, "initialize", {
            protocolVersion: 1,
          })
          assert.strictEqual(init.result.protocolVersion, 1)
          assert.strictEqual(init.result.agentCapabilities.loadSession, true)

          const created = yield* server.request(2, "session/new", {
            cwd: "/tmp",
            mcpServers: [],
          })
          const sessionId: string = created.result.sessionId
          assert.strictEqual(created.result.models.currentModelId, "test:model")

          const done = yield* server.request(3, "session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "hello" }],
          })
          assert.deepStrictEqual(done.result, { stopReason: "end_turn" })

          const updates = server.updates(sessionId)
          assert.deepStrictEqual(
            updates.filter((u) => u.sessionUpdate === "agent_thought_chunk"),
            [
              {
                sessionUpdate: "agent_thought_chunk",
                content: { type: "text", text: "hi there" },
              },
            ],
          )
          assert.deepStrictEqual(updates.at(-1), {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hi there" },
          })
        }),
      ),
    ),
  )

  it.effect("reports cache usage in the ACP usage extension", () =>
    withStore(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* makeServer(() =>
            parts(
              { type: "text-start", id: "1" },
              { type: "text-delta", id: "1", delta: "done" },
              { type: "text-end", id: "1" },
              {
                type: "finish",
                reason: "stop",
                usage: {
                  inputTokens: {
                    total: 120,
                    uncached: 84,
                    cacheRead: 30,
                    cacheWrite: 6,
                  },
                  outputTokens: { total: 12 },
                },
              },
            ),
          )
          const created = yield* server.request(1, "session/new", {
            cwd: "/tmp",
          })
          const sessionId: string = created.result.sessionId

          yield* server.request(2, "session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "hello" }],
          })

          assert.deepStrictEqual(
            server
              .updates(sessionId)
              .find((update) => update.sessionUpdate === "usage_update"),
            {
              sessionUpdate: "usage_update",
              used: 120,
              size: 236_000,
              usage: {
                inputTokens: 84,
                outputTokens: 12,
                cachedReadTokens: 30,
                cachedWriteTokens: 6,
              },
            },
          )
        }),
      ),
    ),
  )

  it.effect(
    "reports zero cache usage when the provider omits cache fields",
    () =>
      withStore(
        Effect.scoped(
          Effect.gen(function* () {
            const server = yield* makeServer(() =>
              parts(
                { type: "text-start", id: "1" },
                { type: "text-delta", id: "1", delta: "done" },
                { type: "text-end", id: "1" },
                {
                  type: "finish",
                  reason: "stop",
                  usage: {
                    inputTokens: { total: 120 },
                    outputTokens: { total: 12 },
                  },
                },
              ),
            )
            const created = yield* server.request(1, "session/new", {
              cwd: "/tmp",
            })
            const sessionId: string = created.result.sessionId

            yield* server.request(2, "session/prompt", {
              sessionId,
              prompt: [{ type: "text", text: "hello" }],
            })

            assert.deepStrictEqual(
              server
                .updates(sessionId)
                .find((update) => update.sessionUpdate === "usage_update"),
              {
                sessionUpdate: "usage_update",
                used: 120,
                size: 236_000,
                usage: {
                  inputTokens: 120,
                  outputTokens: 12,
                  cachedReadTokens: 0,
                  cachedWriteTokens: 0,
                },
              },
            )
          }),
        ),
      ),
  )

  it.effect("applies model and thought-level changes to the next turn", () =>
    withStore(
      Effect.scoped(
        Effect.gen(function* () {
          const resolved: Array<[string, string]> = []
          const server = yield* makeServer(
            () => assistantSays("done"),
            executor,
            (modelId, thoughtLevel) => resolved.push([modelId, thoughtLevel]),
          )
          const created = yield* server.request(1, "session/new", {
            cwd: "/tmp",
          })
          const sessionId: string = created.result.sessionId

          const switched = yield* server.request(2, "session/set_model", {
            sessionId,
            modelId: "other:model",
          })
          assert.strictEqual(
            switched.result.configOptions[0].id,
            "thought_level",
          )

          const configured = yield* server.request(
            3,
            "session/set_config_option",
            { sessionId, configId: "thought_level", value: "high" },
          )
          assert.strictEqual(
            configured.result.configOptions[0].currentValue,
            "high",
          )

          const rejected = yield* server.request(
            4,
            "session/set_config_option",
            { sessionId, configId: "thought_level", value: "turbo" },
          )
          assert.strictEqual(rejected.error?.code, -32602)

          resolved.length = 0
          yield* server.request(5, "session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "use the selected model" }],
          })
          assert.deepStrictEqual(resolved, [["other:model", "high"]])
        }),
      ),
    ),
  )

  it.effect("notifies the config options a model switch changes", () =>
    withStore(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* makeServer(
            () => assistantSays("done"),
            executor,
            undefined,
            undefined,
            (modelId) => modelId === "other:model",
          )
          const created = yield* server.request(1, "session/new", {
            cwd: "/tmp",
          })
          const sessionId: string = created.result.sessionId
          assert.deepStrictEqual(
            created.result.configOptions.map((option: any) => option.id),
            ["thought_level"],
          )

          yield* server.request(2, "session/set_model", {
            sessionId,
            modelId: "other:model",
          })
          const [notified] = server.updates(sessionId)
          assert.strictEqual(notified.sessionUpdate, "config_option_update")
          assert.deepInclude(notified.configOptions[1], {
            id: "fast_mode",
            currentValue: "off",
          })
        }),
      ),
    ),
  )

  for (const script of [
    "console.log(1)",
    'console.log("' + "x".repeat(200) + '")',
    'console.log("first")\nconsole.log("second")',
  ]) {
    it.effect(
      `reports script input as a terminal command: ${JSON.stringify(script)}`,
      () =>
        withStore(
          Effect.scoped(
            Effect.gen(function* () {
              let calls = 0
              const server = yield* makeServer(() =>
                calls++ === 0
                  ? parts({
                      type: "tool-call",
                      id: "call-1",
                      name: "execute",
                      params: { script },
                    })
                  : assistantSays("done"),
              )
              const created = yield* server.request(1, "session/new", {
                cwd: "/tmp",
              })
              const sessionId: string = created.result.sessionId
              yield* server.request(2, "session/prompt", {
                sessionId,
                prompt: [{ type: "text", text: "run it" }],
              })
              const tools = server
                .updates(sessionId)
                .filter((u) => u.sessionUpdate.startsWith("tool_call"))
              assert.strictEqual(tools.length, 2)
              assert.strictEqual(tools[0].sessionUpdate, "tool_call")
              assert.strictEqual(tools[0].kind, "execute")
              assert.strictEqual(tools[0].status, "in_progress")
              assert.deepStrictEqual(tools[0].content, [
                { type: "content", content: { type: "text", text: script } },
              ])
              assert.match(tools[0].title, /^terminal: console\.log\(/)
              assert.notMatch(tools[0].title, /[\r\n]/)
              assert.deepStrictEqual(tools[0].rawInput, { command: script })
              const preview = script.replace(/\s+/g, " ").trim()
              assert.strictEqual(
                tools[0].title,
                "terminal: " + preview.slice(0, 120),
              )
              assert.isAtMost(tools[0].title.length, "terminal: ".length + 120)
            }),
          ),
        ),
    )
  }

  it.effect("reports script stdout as a string without JSON wrapping", () =>
    withStore(
      Effect.scoped(
        Effect.gen(function* () {
          const output = 'first line\n{"value":"✓"}\n'
          let calls = 0
          const server = yield* makeServer(
            () =>
              calls++ === 0
                ? parts({
                    type: "tool-call",
                    id: "call-1",
                    name: "execute",
                    params: { script: "console.log(1)" },
                  })
                : assistantSays("done"),
            {
              ...executor,
              execute: () => Stream.make("first line\n", '{"value":"✓"}\n'),
            },
          )
          const created = yield* server.request(1, "session/new", {
            cwd: "/tmp",
          })
          const sessionId: string = created.result.sessionId
          yield* server.request(2, "session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "run it" }],
          })
          const tools = server
            .updates(sessionId)
            .filter((u) => u.sessionUpdate.startsWith("tool_call"))
          assert.strictEqual(tools.length, 2)
          assert.strictEqual(tools[1].sessionUpdate, "tool_call_update")
          assert.strictEqual(tools[1].toolCallId, tools[0].toolCallId)
          assert.strictEqual(tools[1].status, "completed")
          assert.deepStrictEqual(tools[1].content, [
            { type: "content", content: { type: "text", text: output } },
          ])
          assert.strictEqual(tools[1].rawOutput, output)
        }),
      ),
    ),
  )

  it.effect("reports subagents with a delegate prompt preview", () =>
    withStore(
      Effect.scoped(
        Effect.gen(function* () {
          const prompt =
            "Inspect the repository\nSummarize the findings " + "x".repeat(200)
          const summary = "First finding\nSecond finding\n"
          let calls = 0
          const server = yield* makeServer(
            () =>
              calls++ === 0
                ? parts({
                    type: "tool-call",
                    id: "call-1",
                    name: "execute",
                    params: { script: "await delegate()" },
                  })
                : assistantSays(summary),
            {
              ...executor,
              execute: ({ subagents, environment }) =>
                Stream.fromEffect(
                  subagents.delegate({
                    prompt,
                    background: false,
                    environment: new AgentExecutor.EnvironmentUpdate({
                      environment,
                      update: Option.none(),
                    }),
                  }),
                ).pipe(
                  Stream.map((result) => result.output ?? ""),
                  Stream.orDie,
                ),
            },
          )
          const created = yield* server.request(1, "session/new", {
            cwd: "/tmp",
          })
          const sessionId: string = created.result.sessionId
          yield* server.request(2, "session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "delegate it" }],
          })
          const tools = server
            .updates(sessionId)
            .filter(
              (u) =>
                u.sessionUpdate.startsWith("tool_call") &&
                u.toolCallId.startsWith("subagent-"),
            )
          assert.strictEqual(tools.length, 2)
          assert.strictEqual(tools[0].sessionUpdate, "tool_call")
          assert.strictEqual(tools[0].status, "in_progress")
          assert.deepStrictEqual(tools[0].rawInput, { prompt })
          assert.strictEqual(tools[0].kind, "think")
          assert.strictEqual(tools[1].sessionUpdate, "tool_call_update")
          assert.strictEqual(tools[1].toolCallId, tools[0].toolCallId)
          assert.strictEqual(tools[1].status, "completed")
          assert.match(tools[0].title, /^delegate: Inspect the repository/)
          assert.notMatch(tools[0].title, /[\r\n]/)
          assert.strictEqual(
            tools[0].title,
            "delegate: " + prompt.replace(/\s+/g, " ").slice(0, 120),
          )
          assert.strictEqual(tools[0].title.length, "delegate: ".length + 120)
          assert.deepStrictEqual(tools[1].content, [
            { type: "content", content: { type: "text", text: summary } },
          ])
          assert.strictEqual(tools[1].rawOutput, summary)
        }),
      ),
    ),
  )

  it.effect(
    "resuming a finished subagent does not create its tool call twice",
    () =>
      withStore(
        Effect.scoped(
          Effect.gen(function* () {
            let childId: string | undefined
            let executions = 0
            const server = yield* makeServer(
              ({ prompt }) => {
                if (JSON.stringify(prompt.content).includes("TASK-CHILD")) {
                  const resumed = JSON.stringify(prompt.content).includes(
                    "FOLLOW-UP",
                  )
                  return assistantSays(
                    resumed ? "SECOND-RESULT" : "FIRST-RESULT",
                  )
                }
                const seen = JSON.stringify(prompt.content)
                if (seen.includes("SECOND-RESULT")) return assistantSays("done")
                if (
                  executions === 0 ||
                  (executions === 1 && seen.includes("FIRST-RESULT"))
                ) {
                  return parts({
                    type: "tool-call",
                    id: `call-${executions}`,
                    name: "execute",
                    params: { script: "await work()" },
                  })
                }
                return assistantSays("waiting")
              },
              {
                ...executor,
                // The first script starts a background child; the second
                // resumes it once its first result has been delivered.
                execute: ({ subagents, environment }) =>
                  Stream.fromEffect(
                    executions++ === 0
                      ? subagents
                          .delegate({
                            prompt: "TASK-CHILD",
                            background: true,
                            environment: new AgentExecutor.EnvironmentUpdate({
                              environment,
                              update: Option.none(),
                            }),
                          })
                          .pipe(
                            Effect.map((result) => {
                              childId = result.id
                              return "started"
                            }),
                          )
                      : subagents
                          .messageAgent({ id: childId!, message: "FOLLOW-UP" })
                          .pipe(Effect.as("resumed")),
                  ).pipe(Stream.orDie),
              },
            )
            const created = yield* server.request(1, "session/new", {
              cwd: "/tmp",
            })
            const sessionId: string = created.result.sessionId
            yield* server.request(2, "session/prompt", {
              sessionId,
              prompt: [{ type: "text", text: "delegate and resume" }],
            })

            assert.strictEqual(executions, 2, "the child was resumed")
            const tools = server
              .updates(sessionId)
              .filter(
                (u) =>
                  u.sessionUpdate.startsWith("tool_call") &&
                  u.toolCallId.startsWith("subagent-"),
              )
            const creations = tools
              .filter((u) => u.sessionUpdate === "tool_call")
              .map((u) => u.toolCallId)
            assert.deepStrictEqual(
              creations,
              [...new Set(creations)],
              "ACP tool call IDs must be unique within the session",
            )
            for (const u of tools) {
              assert.include(
                creations,
                u.toolCallId,
                "updates refer to a created tool call",
              )
            }

            const firstDone = tools.findIndex(
              (u) => u.status === "completed" && u.rawOutput === "FIRST-RESULT",
            )
            const secondDone = tools.findIndex(
              (u) =>
                u.status === "completed" && u.rawOutput === "SECOND-RESULT",
            )
            assert.isAbove(firstDone, -1, "first result shown")
            assert.isAbove(secondDone, firstDone, "second result shown")
            assert.isTrue(
              tools
                .slice(firstDone + 1, secondDone)
                .some((u) => u.status === "in_progress"),
              "the resumed turn is shown as running",
            )
            assert.deepStrictEqual(tools[secondDone].content, [
              {
                type: "content",
                content: { type: "text", text: "SECOND-RESULT" },
              },
            ])
          }),
        ),
      ),
  )

  it.effect("advertises the model catalog ahead of the session model", () =>
    withStore(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* makeServer(
            () => assistantSays("done"),
            executor,
            undefined,
            Effect.succeed([{ modelId: "other:model", name: "Other model" }]),
          )
          const created = yield* server.request(1, "session/new", {
            cwd: "/tmp",
          })
          assert.deepStrictEqual(created.result.models, {
            availableModels: [
              { modelId: "other:model", name: "Other model" },
              { modelId: "test:model", name: "test:model" },
            ],
            currentModelId: "test:model",
          })
        }),
      ),
    ),
  )

  it.effect("reports canonical state for new and loaded sessions", () =>
    withStore(
      Effect.gen(function* () {
        const sessionId = yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* makeServer(() => assistantSays("first"))
            const created = yield* server.request(1, "session/new", {
              cwd: "/tmp",
            })
            assert.deepStrictEqual(created.result.models, {
              availableModels: [{ modelId: "test:model", name: "test:model" }],
              currentModelId: "test:model",
            })
            assert.deepInclude(created.result.configOptions[0], {
              id: "thought_level",
              currentValue: "medium",
            })

            const legacy = yield* server.request(2, "session/new", {
              cwd: "/tmp",
              model: "test/model/high",
            })
            assert.strictEqual(legacy.error?.code, -32602)

            yield* server.request(3, "session/set_config_option", {
              sessionId: created.result.sessionId,
              configId: "thought_level",
              value: "high",
            })
            yield* server.request(4, "session/prompt", {
              sessionId: created.result.sessionId,
              prompt: [{ type: "text", text: "hello" }],
            })
            return created.result.sessionId as string
          }),
        )

        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* makeServer(() => assistantSays("second"))
            const loaded = yield* server.request(1, "session/load", {
              sessionId,
              cwd: "/tmp",
              mcpServers: [],
            })
            assert.strictEqual(
              loaded.result.models.currentModelId,
              "test:model",
            )
            assert.strictEqual(
              loaded.result.configOptions[0].currentValue,
              "high",
            )
            assert.deepStrictEqual(
              server.updates(sessionId).map((u) => u.sessionUpdate),
              ["user_message_chunk", "agent_message_chunk"],
            )

            const missing = yield* server.request(2, "session/load", {
              sessionId: "nope",
              cwd: "/tmp",
            })
            assert.strictEqual(missing.error!.code, -32602)
            assert.match(missing.error!.message, /Session not found/)
          }),
        )
      }),
    ),
  )

  it.effect(
    "hides a persisted compaction summary during replay but keeps it for the next model call",
    () =>
      withStore(
        Effect.scoped(
          Effect.gen(function* () {
            const kvs = yield* KeyValueStore.KeyValueStore
            const store = KeyValueStore.toSchemaStore(
              KeyValueStore.prefix(kvs, "session-"),
              Acp.SessionRecord,
            )
            const sessionId = "compacted-session"
            const userText =
              "Explain the <compaction-summary> tag without hiding this message"
            const history = Compaction.rewrite({
              system: Option.some(
                Prompt.makeMessage("system", { content: "Original system" }),
              ),
              summary: "PRIVATE-COMPACTION-SUMMARY",
              kept: [
                Prompt.makeMessage("user", {
                  content: [Prompt.makePart("text", { text: userText })],
                }),
                Prompt.makeMessage("assistant", {
                  content: [
                    Prompt.makePart("text", { text: "Kept assistant reply" }),
                  ],
                }),
              ],
            })
            yield* store.set(
              sessionId,
              new Acp.SessionRecord({
                cwd: "/tmp",
                model: "test:model",
                thoughtLevel: "medium",
                history,
              }),
            )

            let modelPrompt: Prompt.Prompt | undefined
            const server = yield* makeServer((options) => {
              modelPrompt = options.prompt
              return assistantSays("Continued after reload")
            })
            const loaded = yield* server.request(1, "session/load", {
              sessionId,
              cwd: "/tmp",
            })
            assert.isUndefined(loaded.error)
            const replay = server.updates(sessionId)

            const continued = yield* server.request(2, "session/prompt", {
              sessionId,
              prompt: [{ type: "text", text: "continue" }],
            })
            assert.deepStrictEqual(continued.result, { stopReason: "end_turn" })
            assert.isDefined(modelPrompt)
            assert.deepStrictEqual(
              Compaction.findPreviousSummary(modelPrompt!),
              Option.some("PRIVATE-COMPACTION-SUMMARY"),
            )
            const persisted = Option.getOrThrow(yield* store.get(sessionId))
            assert.deepStrictEqual(
              Compaction.findPreviousSummary(persisted.history),
              Option.some("PRIVATE-COMPACTION-SUMMARY"),
            )

            assert.deepStrictEqual(replay, [
              {
                sessionUpdate: "user_message_chunk",
                content: { type: "text", text: userText },
              },
              {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Kept assistant reply" },
              },
            ])
          }),
        ),
      ),
  )

  it.live("keeps the working directory across a session reload", () =>
    withStore(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const cwd = yield* fs.makeTempDirectoryScoped()
        const sessionId = yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* makeServer(
              runsScript(`await bash({ command: "mkdir sub" })
await changeDirectory("sub")`),
              yield* localExecutor(cwd),
            )
            const created = yield* server.request(1, "session/new", { cwd })
            const sessionId: string = created.result.sessionId
            yield* server.request(2, "session/prompt", {
              sessionId,
              prompt: [{ type: "text", text: "change directory" }],
            })
            return sessionId
          }),
        )

        const output = yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* makeServer(
              runsScript(
                `console.log("PWD:" + (await bash({ command: "pwd" })).trim())`,
              ),
              yield* localExecutor(cwd),
            )
            yield* server.request(1, "session/load", { sessionId, cwd })
            yield* server.request(2, "session/prompt", {
              sessionId,
              prompt: [{ type: "text", text: "print it" }],
            })
            return server
              .updates(sessionId)
              .filter((u) => u.sessionUpdate === "tool_call_update")
              .map((u) => String(u.rawOutput))
              .join("\n")
          }),
        )
        assert.match(output, /PWD:\S*\/sub$/m)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  )

  it.effect(
    "hides environment updates and sub-agent results during replay",
    () =>
      withStore(
        Effect.scoped(
          Effect.gen(function* () {
            const kvs = yield* KeyValueStore.KeyValueStore
            const store = KeyValueStore.toSchemaStore(
              KeyValueStore.prefix(kvs, "session-"),
              Acp.SessionRecord,
            )
            const sessionId = "injected-session"
            yield* store.set(
              sessionId,
              new Acp.SessionRecord({
                cwd: "/tmp",
                model: "test:model",
                thoughtLevel: "medium",
                history: Prompt.fromMessages([
                  message("user", "Typed by the user"),
                  message(
                    "user",
                    "<environment-update>\nPKG-RULES\n</environment-update>",
                  ),
                  message(
                    "user",
                    '<subagent id="1" status="completed">\nCHILD-RESULT\n</subagent>',
                  ),
                  message("assistant", "Reply"),
                ]),
              }),
            )

            const server = yield* makeServer(() => assistantSays("unused"))
            const loaded = yield* server.request(1, "session/load", {
              sessionId,
              cwd: "/tmp",
            })
            assert.isUndefined(loaded.error)
            assert.deepStrictEqual(server.updates(sessionId), [
              {
                sessionUpdate: "user_message_chunk",
                content: { type: "text", text: "Typed by the user" },
              },
              {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Reply" },
              },
            ])
          }),
        ),
      ),
  )

  it.effect("rejects unknown models and methods", () =>
    withStore(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* makeServer(() => assistantSays("x"))
          const created = yield* server.request(1, "session/new", {
            cwd: "/tmp",
            model: "unknown/model",
          })
          assert.strictEqual(created.error!.code, -32602)

          const ok = yield* server.request(2, "session/new", { cwd: "/tmp" })
          const set = yield* server.request(3, "session/set_model", {
            sessionId: ok.result.sessionId,
            modelId: "unknown/model",
          })
          assert.strictEqual(set.error!.code, -32602)

          const missing = yield* server.request(4, "session/nope", {})
          assert.strictEqual(missing.error!.code, -32601)
        }),
      ),
    ),
  )

  it.live("cancels a running prompt", () =>
    withStore(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* makeServer(() =>
            parts({ type: "text-start", id: "1" }).pipe(
              Stream.concat(Stream.never),
            ),
          )
          const created = yield* server.request(1, "session/new", {
            cwd: "/tmp",
          })
          const sessionId: string = created.result.sessionId
          const prompt = yield* server
            .request(2, "session/prompt", {
              sessionId,
              prompt: [{ type: "text", text: "hello" }],
            })
            .pipe(Effect.forkScoped)
          yield* Effect.sleep(10)
          yield* server.notify("session/cancel", { sessionId })
          const done = yield* Fiber.join(prompt)
          assert.deepStrictEqual(done.result, { stopReason: "cancelled" })
        }),
      ),
    ),
  )

  it.effect("queues a steer message into the running prompt", () =>
    withStore(
      Effect.scoped(
        Effect.gen(function* () {
          const script = yield* gatedScript()
          const prompts: Array<Prompt.Prompt> = []
          const server = yield* makeServer((options) => {
            prompts.push(options.prompt)
            return prompts.length === 1 ? callsExecute : assistantSays("done")
          }, script.executor)
          const created = yield* server.request(1, "session/new", {
            cwd: "/tmp",
          })
          const sessionId: string = created.result.sessionId
          const prompt = yield* server
            .request(2, "session/prompt", {
              sessionId,
              prompt: [{ type: "text", text: "hello" }],
            })
            .pipe(Effect.forkScoped)
          yield* Deferred.await(script.started)

          // Answered while the script still runs, before the agent reads it.
          const steered = yield* server.request(3, "_session/steer", {
            sessionId,
            message: "also update the docs",
          })
          assert.deepStrictEqual(steered.result, { queued: true })

          yield* Deferred.succeed(script.release, undefined)
          const done = yield* Fiber.join(prompt)
          assert.deepStrictEqual(done.result, { stopReason: "end_turn" })
          // Read within the turn: one model call before it and one after,
          // with no extra turn to replay it.
          assert.strictEqual(prompts.length, 2)
          assert.include(JSON.stringify(prompts.at(-1)), "also update the docs")
        }),
      ),
    ),
  )

  it.effect("does not queue a steer message without a running prompt", () =>
    withStore(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* makeServer(() => assistantSays("done"))
          const created = yield* server.request(1, "session/new", {
            cwd: "/tmp",
          })
          const sessionId: string = created.result.sessionId
          const steer = (id: number) =>
            server.request(id, "_session/steer", {
              sessionId,
              message: "also update the docs",
            })

          const idle = yield* steer(2)
          yield* server.request(3, "session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "hello" }],
          })
          const afterTurn = yield* steer(4)

          for (const response of [idle, afterTurn]) {
            assert.notStrictEqual(response.error?.code, -32601)
            assert.notDeepEqual(response.result, { queued: true })
          }
        }),
      ),
    ),
  )

  it.effect(
    "does not lose a steer message queued while the turn completes",
    () =>
      withStore(
        Effect.scoped(
          Effect.gen(function* () {
            const script = yield* gatedScript({ completesTask: true })
            const prompts: Array<Prompt.Prompt> = []
            const server = yield* makeServer((options) => {
              prompts.push(options.prompt)
              return prompts.length === 1 ? callsExecute : assistantSays("done")
            }, script.executor)
            const created = yield* server.request(1, "session/new", {
              cwd: "/tmp",
            })
            const sessionId: string = created.result.sessionId
            const prompt = yield* server
              .request(2, "session/prompt", {
                sessionId,
                prompt: [{ type: "text", text: "hello" }],
              })
              .pipe(Effect.forkScoped)
            // The script has called taskComplete and is still running.
            yield* Deferred.await(script.started)

            const steered = yield* server.request(3, "_session/steer", {
              sessionId,
              message: "also update the docs",
            })
            yield* Deferred.succeed(script.release, undefined)
            yield* Fiber.join(prompt)

            // Either refused, or queued and seen by the model.
            assert.isBoolean(steered.result?.queued)
            if (steered.result.queued) {
              assert.include(
                JSON.stringify(prompts.at(-1)),
                "also update the docs",
              )
            }
          }),
        ),
      ),
  )

  it.effect("reports prompts still running when stdin ends", () =>
    withStore(
      Effect.gen(function* () {
        const modelCalled = yield* Deferred.make<void>()
        const languageModel = yield* LanguageModel.make({
          generateText: () => Effect.succeed([]),
          streamText: () =>
            Stream.fromEffect(Deferred.succeed(modelCalled, undefined)).pipe(
              Stream.drain,
              Stream.concat(Stream.never),
            ),
        })
        const modelLayer = Layer.mergeAll(
          Layer.succeed(LanguageModel.LanguageModel, languageModel),
          Layer.succeed(Model.ProviderName, "test"),
          Layer.succeed(Model.ModelName, "model"),
        )

        const decoder = new TextDecoder()
        const decode = (chunk: string | Uint8Array) =>
          typeof chunk === "string" ? chunk : decoder.decode(chunk)
        const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done>()
        const stdout = yield* Queue.unbounded<string>()
        const stdoutLines: Array<string> = []
        // Both the stderr sink and log output reach stderr in the CLI.
        const stderr: Array<string> = []
        const stdio = Stdio.layerTest({
          stdin: Stream.fromQueue(stdin),
          stdout: () =>
            Sink.forEach((chunk) =>
              Effect.sync(() => {
                for (const line of decode(chunk).split("\n")) {
                  if (line === "") continue
                  stdoutLines.push(line)
                  Queue.offerUnsafe(stdout, line)
                }
              }),
            ),
          stderr: () =>
            Sink.forEach((chunk) =>
              Effect.sync(() => {
                stderr.push(decode(chunk))
              }),
            ),
        })
        const logger = Logger.layer([
          Logger.make((options) => {
            stderr.push(Logger.formatSimple.log(options))
          }),
        ])

        const send = (message: object) =>
          Queue.offer(
            stdin,
            new TextEncoder().encode(
              `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`,
            ),
          )
        const response = (id: number) =>
          Queue.take(stdout).pipe(
            Effect.map((line): Message => JSON.parse(line)),
            Effect.repeat({ until: (message) => message.id === id }),
          )

        const server = yield* Acp.runStdio({
          version: "test",
          defaultModel: "test:model",
          defaultThoughtLevel: "medium",
          makeAgent: () =>
            Agent.make.pipe(
              Effect.provideService(AgentExecutor.AgentExecutor, executor),
            ),
          makeModel: () =>
            Option.some(
              Layer.merge(modelLayer, Agent.layerSubagentModel(modelLayer)),
            ),
        }).pipe(Effect.provide([stdio, logger]), Effect.forkChild)

        yield* send({ id: 1, method: "session/new", params: { cwd: "/tmp" } })
        const sessionId: string = (yield* response(1)).result.sessionId
        yield* send({
          id: 2,
          method: "session/prompt",
          params: { sessionId, prompt: [{ type: "text", text: "hello" }] },
        })
        yield* Deferred.await(modelCalled)
        yield* Queue.end(stdin)
        yield* Fiber.join(server)

        for (const line of stdoutLines) {
          assert.strictEqual(JSON.parse(line).jsonrpc, "2.0")
        }
        assert.isTrue(
          stderr.some((line) => line.includes(sessionId)),
          `expected a stderr diagnostic naming session ${sessionId}, got: ${JSON.stringify(stderr)}`,
        )
      }),
    ),
  )
})

// --- MCP servers ---------------------------------------------------------------

const systemText = (prompt: Prompt.Prompt): string =>
  prompt.content
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n")

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const exited = (pid: number) =>
  Effect.sync(() => isRunning(pid)).pipe(
    Effect.repeat({
      while: (running) => running,
      schedule: Schedule.spaced("50 millis"),
    }),
    Effect.timeout("3 seconds"),
  )

const remoteServer = (path?: string) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      listenHttp(
        makeFakeServer({
          tools: [{ name: "ping", call: () => text("pong") }],
        }),
        path,
      ),
    ),
    (remote) => Effect.promise(remote.close),
  )

/**
 * An ACP stdio entry running the fixture server, which writes its pid and cwd
 * to `out`.
 */
const stdioServer = (path: Path.Path, name: string, out: string) => ({
  name,
  command: process.execPath,
  args: [path.join(import.meta.dirname, "fixtures", "McpStdioServer.ts")],
  env: [{ name: "FIXTURE_OUT", value: out }],
})

const readStarted = (out: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return JSON.parse(yield* fs.readFileString(out)) as {
      readonly pid: number
      readonly cwd: string
    }
  })

describe("Acp MCP servers", () => {
  it.live("connects stdio and http servers and reports failed ones once", () =>
    withStore(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const out = path.join(cwd, "started.json")
        const remote = yield* remoteServer()
        const systems: Array<string> = []
        const server = yield* makeServer((options) => {
          systems.push(systemText(options.prompt))
          return assistantSays("ok")
        })

        const init = yield* server.request(1, "initialize", {
          protocolVersion: 1,
        })
        assert.deepStrictEqual(init.result.agentCapabilities.mcpCapabilities, {
          http: true,
          sse: false,
        })
        assert.isDefined(
          init.result.agentCapabilities.sessionCapabilities?.close,
        )

        const created = yield* server.request(2, "session/new", {
          cwd,
          mcpServers: [
            // stdio has no `type`.
            stdioServer(path, "acpstdio", out),
            {
              type: "http",
              name: "acphttp",
              url: remote.url,
              headers: [{ name: "Authorization", value: "Bearer secret" }],
            },
            {
              type: "sse",
              name: "acplegacy",
              url: "http://127.0.0.1:9/sse",
              headers: [],
            },
            // A later duplicate is skipped.
            {
              name: "acpstdio",
              command: "/nonexistent/clanka-mcp",
              args: [],
              env: [],
            },
          ],
        })
        assert.isUndefined(created.error)
        const sessionId: string = created.result.sessionId
        for (const id of [3, 4]) {
          yield* server.request(id, "session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "hello" }],
          })
        }

        const failures = server
          .updates(sessionId)
          .filter(
            (u) =>
              u.sessionUpdate === "agent_thought_chunk" &&
              String(u.content.text).includes("MCP server"),
          )
          .map((u) => String(u.content.text))
        assert.strictEqual(failures.length, 1)
        assert.include(
          failures[0],
          'MCP server "acplegacy" failed: SSE transport is not supported',
        )
        assert.notInclude(failures[0], "acpstdio")

        assert.include(systems[0], "acpstdio")
        assert.include(systems[0], "acphttp")
        // Stdio servers run in the session's cwd.
        const started = yield* readStarted(out)
        assert.strictEqual(started.cwd, yield* fs.realPath(cwd))
        assert.isNotEmpty(remote.authorization)
        for (const header of remote.authorization) {
          assert.strictEqual(header, "Bearer secret")
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  )

  it.live(
    "resume connects the sent servers, which are never persisted, and close ends them",
    () =>
      withStore(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const kvs = yield* KeyValueStore.KeyValueStore
          const cwd = yield* fs.makeTempDirectoryScoped()
          const remote = yield* remoteServer("/BROKER-TOKEN")
          const systems: Array<string> = []
          const server = yield* makeServer((options) => {
            systems.push(systemText(options.prompt))
            return assistantSays("ok")
          })
          const prompt = (id: number, sessionId: string) =>
            server.request(id, "session/prompt", {
              sessionId,
              prompt: [{ type: "text", text: "hello" }],
            })

          const created = yield* server.request(1, "session/new", {
            cwd,
            mcpServers: [
              stdioServer(path, "acpfirst", path.join(cwd, "first.json")),
              { type: "http", name: "acpbroker", url: remote.url, headers: [] },
            ],
          })
          const sessionId: string = created.result.sessionId
          yield* prompt(2, sessionId)
          const first = yield* readStarted(path.join(cwd, "first.json"))

          const closed = yield* server.request(3, "session/close", {
            sessionId,
          })
          assert.isUndefined(closed.error)
          yield* exited(first.pid)
          const afterClose = yield* prompt(4, sessionId)
          assert.isDefined(afterClose.error)

          const persisted = yield* kvs.get(`session-${sessionId}`)
          assert.isDefined(persisted)
          assert.notInclude(persisted, "BROKER-TOKEN")

          const resumed = yield* server.request(5, "session/resume", {
            sessionId,
            cwd,
            mcpServers: [
              stdioServer(path, "acpsecond", path.join(cwd, "second.json")),
            ],
          })
          assert.isUndefined(resumed.error)
          yield* prompt(6, sessionId)
          const system = systems.at(-1)!
          assert.include(system, "acpsecond")
          assert.notInclude(system, "acpfirst")
          assert.notInclude(system, "acpbroker")

          const second = yield* readStarted(path.join(cwd, "second.json"))
          yield* server.request(7, "session/close", { sessionId })
          yield* exited(second.pid)
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
  )

  it.live("starts servers named like Object.prototype members", () =>
    withStore(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const server = yield* makeServer(() => assistantSays("ok"))
        const names = ["constructor", "__proto__"]
        const created = yield* server.request(1, "session/new", {
          cwd,
          mcpServers: names.map((name) =>
            stdioServer(path, name, path.join(cwd, `${name}.json`)),
          ),
        })
        assert.isUndefined(created.error)
        for (const name of names) {
          assert.isTrue(
            yield* fs.exists(path.join(cwd, `${name}.json`)),
            `${name} was not started`,
          )
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  )
})

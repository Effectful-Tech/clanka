import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as Prompt from "effect/ai/Prompt"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import type * as Response from "effect/ai/Response"
import * as Acp from "./Acp.ts"
import * as Agent from "./Agent.ts"
import * as AgentExecutor from "./AgentExecutor.ts"
import * as Compaction from "./Compaction.ts"

type Message = {
  readonly id?: number
  readonly method?: string
  readonly result?: any
  readonly error?: { readonly code: number; readonly message: string }
  readonly params?: any
}

const capabilities = new AgentExecutor.Capabilities({
  toolsDts: "",
  agentsMd: Option.none(),
  supportsSearch: false,
  skills: [],
})

const executor = AgentExecutor.AgentExecutor.of({
  capabilities: Effect.succeed(capabilities),
  execute: () => Stream.make("script output"),
  executeUnsafe: () => Effect.die("executeUnsafe not implemented"),
})

const makeServer = (
  streamText: Parameters<typeof LanguageModel.make>[0]["streamText"],
  agentExecutor = executor,
  onMakeModel?: (modelId: string, thoughtLevel: string) => void,
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
              usage: {
                inputTokens: 120,
                outputTokens: 12,
                cacheRead: 30,
                cacheWrite: 6,
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
                usage: {
                  inputTokens: 120,
                  outputTokens: 12,
                  cacheRead: 0,
                  cacheWrite: 0,
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

          yield* server.request(2, "session/set_model", {
            sessionId,
            modelId: "other:model",
          })

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
              execute: ({ onSubagent }) =>
                Stream.fromEffect(onSubagent(prompt)),
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
})

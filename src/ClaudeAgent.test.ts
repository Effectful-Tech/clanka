import type {
  Options,
  query as SdkQuery,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { assert, describe, it } from "@effect/vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Base64 from "effect/encoding/Base64"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Prompt from "effect/ai/Prompt"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as ClaudeAgent from "./ClaudeAgent.ts"
import { tinyPng } from "./fixtures/TestImages.ts"

const system = Prompt.makeMessage("system", { content: "You are clanka." })

const user = (text: string) =>
  Prompt.makeMessage("user", {
    content: [Prompt.makePart("text", { text })],
  })

const script = 'await bash("pnpm test")'

const history = Prompt.fromMessages([
  system,
  Prompt.makeMessage("user", {
    content: [
      Prompt.makePart("text", { text: "Fix the failing test" }),
      Prompt.makePart("file", { mediaType: "image/png", data: tinyPng }),
    ],
  }),
  Prompt.makeMessage("assistant", {
    content: [
      Prompt.makePart("tool-call", {
        id: "toolu_1",
        name: "execute",
        params: { script },
        providerExecuted: false,
      }),
    ],
  }),
  Prompt.makeMessage("tool", {
    content: [
      Prompt.makePart("tool-result", {
        id: "toolu_1",
        name: "execute",
        isFailure: false,
        result: "1 failed",
        providerExecuted: false,
      }),
    ],
  }),
  Prompt.makeMessage("assistant", {
    content: [Prompt.makePart("text", { text: "Fixed it." })],
  }),
  user("Thanks, now commit"),
])

// Trimmed Agent SDK messages, carrying the fields a step's conversion reads.
const frame = { parent_tool_use_id: null, uuid: "u", session_id: "s" }
const event = (event: object) => ({ ...frame, type: "stream_event", event })
const assistant = (block: object) => ({
  ...frame,
  type: "assistant",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [block],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 1 },
  },
})

// One model step that thinks, says something, then calls clanka's `execute`
// tool and a Claude Code tool clanka did not offer.
const toolStep = [
  event({
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
        output_tokens: 1,
      },
    },
  }),
  event({
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "", signature: "" },
  }),
  event({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "Run the tests " },
  }),
  event({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "first." },
  }),
  event({ type: "content_block_stop", index: 0 }),
  assistant({
    type: "thinking",
    thinking: "Run the tests first.",
    signature: "sig",
  }),
  event({
    type: "content_block_start",
    index: 1,
    content_block: { type: "text", text: "" },
  }),
  event({
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "Running the tests." },
  }),
  event({ type: "content_block_stop", index: 1 }),
  assistant({ type: "text", text: "Running the tests." }),
  event({
    type: "content_block_start",
    index: 2,
    content_block: {
      type: "tool_use",
      id: "toolu_1",
      name: "mcp__clanka__execute",
      input: {},
    },
  }),
  event({
    type: "content_block_delta",
    index: 2,
    delta: {
      type: "input_json_delta",
      partial_json: JSON.stringify({ script }),
    },
  }),
  event({ type: "content_block_stop", index: 2 }),
  assistant({
    type: "tool_use",
    id: "toolu_1",
    name: "mcp__clanka__execute",
    input: { script },
  }),
  assistant({
    type: "tool_use",
    id: "toolu_2",
    name: "Bash",
    input: { command: "ls" },
  }),
  event({
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 20 },
  }),
  event({ type: "message_stop" }),
]

describe("ClaudeAgent", () => {
  it("runs Claude Code with only clanka's tools, instructions and settings", () => {
    const options = ClaudeAgent.queryOptions({
      model: "claude-opus-5-5",
      prompt: Prompt.fromMessages([system, user("hello")]),
      cwd: "/work",
      pathToClaudeCodeExecutable: "/opt/claude",
    })
    assert.deepInclude(options, {
      model: "claude-opus-5-5",
      cwd: "/work",
      pathToClaudeCodeExecutable: "/opt/claude",
      tools: [],
      allowedTools: ["mcp__clanka__*"],
      permissionMode: "dontAsk",
      settingSources: [],
      settings: { disableAllHooks: true },
      strictMcpConfig: true,
      persistSession: false,
    })
    assert.deepInclude(options.systemPrompt, {
      type: "custom",
      prompt: "You are clanka.",
    })
    assert.deepInclude(options.env, {
      PATH: process.env.PATH,
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      DISABLE_AUTO_COMPACT: "1",
      ENABLE_TOOL_SEARCH: "false",
    })
    assert.match(options.env?.CLAUDE_AGENT_SDK_CLIENT_APP ?? "", /^clanka\//)
  })

  it("renders the history as one user message, with images as image blocks", () => {
    const content = ClaudeAgent.toUserContent(history)
    assert.deepStrictEqual(
      content.filter((block) => block.type === "image"),
      [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: Base64.encode(tinyPng),
          },
        },
      ],
    )
    const text = content.flatMap((block) =>
      block.type === "text" ? [block.text] : [],
    )
    const rendered = text.join("\n")
    assert.notInclude(rendered, "You are clanka.")
    const positions = [
      "Fix the failing test",
      script,
      "1 failed",
      "Fixed it.",
      "Thanks, now commit",
    ].map((part) => rendered.indexOf(part))
    assert.notInclude(positions, -1)
    assert.deepStrictEqual(
      positions,
      positions.toSorted((a, b) => a - b),
    )
  })

  it.effect("converts a tool step to response parts", () =>
    Effect.gen(function* () {
      const parts = yield* Stream.fromIterable(toolStep as Array<any>).pipe(
        ClaudeAgent.toStreamParts,
        Stream.runCollect,
      )
      const deltas = (type: "text-delta" | "reasoning-delta") =>
        parts.flatMap((part) => (part.type === type ? [part.delta] : []))
      assert.strictEqual(
        deltas("reasoning-delta").join(""),
        "Run the tests first.",
      )
      assert.strictEqual(deltas("text-delta").join(""), "Running the tests.")
      assert.deepStrictEqual(
        parts.flatMap((part) =>
          part.type === "tool-call"
            ? [{ id: part.id, name: part.name, params: part.params }]
            : [],
        ),
        [{ id: "toolu_1", name: "execute", params: { script } }],
      )
      const finish = parts.filter((part) => part.type === "finish")
      assert.lengthOf(finish, 1)
      assert.strictEqual(finish[0]!.reason, "tool-calls")
      assert.strictEqual(finish[0]!.usage.inputTokens.total, 160)
      assert.strictEqual(finish[0]!.usage.outputTokens.total, 20)
    }),
  )
})

// A fake Claude Code behind the SDK's `query()`. `run` plays one session
// against its input and clanka's MCP server.
interface FakeSession {
  readonly options: Options
  readonly input: AsyncIterator<SDKUserMessage>
  closed: boolean
}

const fakeClaude = (run: (session: FakeSession) => AsyncGenerator<object>) => {
  const sessions: Array<FakeSession> = []
  const query = (params: {
    readonly prompt: AsyncIterable<SDKUserMessage>
    readonly options: Options
  }) => {
    const session: FakeSession = {
      options: params.options,
      input: params.prompt[Symbol.asyncIterator](),
      closed: false,
    }
    sessions.push(session)
    return Object.assign(run(session), {
      initializationResult: async () => ({ claude_code_version: "2.1.312" }),
      close: () => {
        session.closed = true
      },
    })
  }
  return { sessions, query: query as unknown as typeof SdkQuery }
}

// Claude Code calling clanka's `execute` tool over MCP, each call tagged with
// its tool use id unless `tagged` is false.
const callExecute = async (
  session: FakeSession,
  calls: ReadonlyArray<readonly [id: string, script: string]>,
  tagged = true,
) => {
  const server = session.options.mcpServers?.clanka as {
    readonly instance: {
      connect: (transport: InMemoryTransport) => Promise<void>
    }
  }
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await server.instance.connect(serverTransport)
  const client = new Client({ name: "claude-code", version: "0.0.0" })
  await client.connect(clientTransport)
  return Promise.all(
    calls.map(([id, script]) =>
      client.callTool({
        name: "execute",
        arguments: { script },
        ...(tagged ? { _meta: { "claudecode/toolUseId": id } } : {}),
      }),
    ),
  )
}

// One API message calling `execute` once per call.
const executeStep = (calls: ReadonlyArray<readonly [string, string]>) => [
  event({
    type: "message_start",
    message: {
      id: "msg_tools",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  }),
  ...calls.map(([id, script]) =>
    assistant({
      type: "tool_use",
      id,
      name: "mcp__clanka__execute",
      input: { script },
    }),
  ),
  event({
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 5 },
  }),
  event({ type: "message_stop" }),
]

const finalStep = [
  assistant({ type: "text", text: "Done." }),
  {
    ...frame,
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done.",
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 2 },
  },
]

// The start of a step that is still writing its reply.
const replying = [
  ...executeStep([]).slice(0, 1),
  event({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }),
  event({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Working" },
  }),
]

const Execute = Toolkit.make(
  Tool.make("execute", {
    parameters: Schema.Struct({ script: Schema.String }),
    success: Schema.String,
  }),
)

// The scripts clanka's `execute` handler ran.
const executed: Array<string> = []

const ExecuteHandlers = Execute.toLayer({
  execute: ({ script }) =>
    Effect.sync(() => {
      executed.push(script)
      return `ran ${script}`
    }),
})

const modelWith = (fake: ReturnType<typeof fakeClaude>) =>
  Layer.merge(
    ClaudeAgent.model("claude-opus-5-5", {
      executable: "/fake/claude",
      query: fake.query,
    }),
    ExecuteHandlers,
  )

const runSteps = Effect.fnUntraced(function* (
  fake: ReturnType<typeof fakeClaude>,
  next: (first: Prompt.Prompt, response: Prompt.Prompt) => Prompt.Prompt,
) {
  const first = Prompt.fromMessages([system, user("go")])
  yield* Effect.gen(function* () {
    const ai = yield* LanguageModel.LanguageModel
    const parts = yield* ai
      .streamText({ prompt: first, toolkit: Execute })
      .pipe(Stream.runCollect)
    yield* ai
      .streamText({
        prompt: next(first, Prompt.fromResponseParts(parts)),
        toolkit: Execute,
      })
      .pipe(Stream.runCollect)
  }).pipe(Effect.provide(modelWith(fake)))
})

describe("ClaudeAgent.model", () => {
  it.effect("hands each parked call the result of its own tool use", () =>
    Effect.gen(function* () {
      const calls = [
        ["toolu_a", "a"],
        ["toolu_b", "b"],
      ] as const
      let results: ReadonlyArray<unknown> = []
      const fake = fakeClaude(async function* (session) {
        await session.input.next()
        yield* executeStep(calls)
        results = await callExecute(session, calls)
        yield* finalStep
      })
      yield* runSteps(fake, (first, response) => Prompt.concat(first, response))
      assert.deepStrictEqual(
        results.map((result: any) => result.content),
        [[{ type: "text", text: "ran a" }], [{ type: "text", text: "ran b" }]],
      )
      assert.lengthOf(fake.sessions, 1)
    }),
  )

  it.effect(
    "fails untagged calls instead of guessing which call they are",
    () =>
      Effect.gen(function* () {
        const calls = [
          ["toolu_a", "a"],
          ["toolu_b", "b"],
        ] as const
        let results: ReadonlyArray<unknown> = []
        executed.length = 0
        const fake = fakeClaude(async function* (session) {
          await session.input.next()
          yield* executeStep(calls)
          results = await callExecute(session, calls, false)
          yield* finalStep
        })
        // The step may fail; what matters is that no script runs.
        yield* Effect.exit(
          runSteps(fake, (first, response) => Prompt.concat(first, response)),
        )
        assert.deepStrictEqual(
          results.map((result: any) => result.isError),
          [true, true],
        )
        assert.deepStrictEqual(executed, [])
      }),
  )

  it.effect(
    "starts over when the prompt's answer is not the one Claude gave",
    () =>
      Effect.gen(function* () {
        const fake = fakeClaude(async function* (session) {
          await session.input.next()
          yield* finalStep
          await session.input.next()
          yield* finalStep
        })
        yield* runSteps(fake, (first) =>
          Prompt.fromMessages([
            ...first.content,
            Prompt.makeMessage("assistant", {
              content: [Prompt.makePart("text", { text: "Edited." })],
            }),
            user("Repeat your answer"),
          ]),
        )
        assert.lengthOf(fake.sessions, 2)
        assert.isTrue(fake.sessions[0]!.closed)
      }),
  )

  it.effect("closes Claude Code when a step is cut short", () =>
    Effect.gen(function* () {
      const fake = fakeClaude(async function* (session) {
        await session.input.next()
        yield* replying
        await new Promise(() => {})
      })
      const prompt = Prompt.fromMessages([system, user("go")])
      yield* Effect.gen(function* () {
        const ai = yield* LanguageModel.LanguageModel
        // Steering cuts the stream after a text part, as Agent does.
        yield* ai.streamText({ prompt, toolkit: Execute }).pipe(
          Stream.takeUntil((part) => part.type === "text-delta"),
          Stream.runDrain,
        )
        assert.isTrue(fake.sessions[0]!.closed)
      }).pipe(Effect.provide(modelWith(fake)))
    }),
  )

  it.effect(
    "refuses a second step while one is read, keeping the first session",
    () =>
      Effect.gen(function* () {
        let release!: () => void
        const released = new Promise<void>((resolve) => {
          release = resolve
        })
        const fake = fakeClaude(async function* (session) {
          await session.input.next()
          if (session === fake.sessions[0]) {
            yield* replying
            await released
          }
          yield* finalStep
        })
        yield* Effect.gen(function* () {
          const ai = yield* LanguageModel.LanguageModel
          const reading = yield* Deferred.make<void>()
          const first = yield* ai
            .streamText({
              prompt: Prompt.fromMessages([system, user("go")]),
              toolkit: Execute,
            })
            .pipe(
              Stream.tap(() => Deferred.succeed(reading, undefined)),
              Stream.runDrain,
              Effect.forkChild,
            )
          yield* Deferred.await(reading)
          const second = yield* ai
            .streamText({
              prompt: Prompt.fromMessages([system, user("something else")]),
              toolkit: Execute,
            })
            .pipe(Stream.runDrain, Effect.exit)
          assert.isTrue(Exit.isFailure(second))
          assert.lengthOf(fake.sessions, 1)
          assert.isFalse(fake.sessions[0]!.closed)
          release()
          yield* Fiber.join(first)
        }).pipe(Effect.provide(modelWith(fake)))
      }),
  )

  it.live("fails a reader whose session was closed instead of hanging", () =>
    Effect.gen(function* () {
      const fake = fakeClaude(async function* (session) {
        await session.input.next()
        yield* replying
        await new Promise(() => {})
      })
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(modelWith(fake), scope)
      const reading = yield* Deferred.make<void>()
      const reader = yield* Context.get(context, LanguageModel.LanguageModel)
        .streamText({
          prompt: Prompt.fromMessages([system, user("go")]),
          toolkit: Execute,
        })
        .pipe(
          Stream.tap(() => Deferred.succeed(reading, undefined)),
          Stream.runDrain,
          Effect.provideContext(context),
          Effect.forkChild,
        )
      yield* Deferred.await(reading)
      // Closing the model closes Claude Code under the step being read.
      yield* Scope.close(scope, Exit.void)
      const error = yield* Fiber.join(reader).pipe(
        Effect.flip,
        Effect.timeout("1 second"),
      )
      assert.strictEqual(error._tag, "AiError")
    }),
  )
})

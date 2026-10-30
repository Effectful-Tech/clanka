import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import * as Stream from "effect/Stream"
import * as Prompt from "effect/ai/Prompt"
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

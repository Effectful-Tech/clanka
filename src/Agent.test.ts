import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Stream } from "effect"
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { AgentModelConfig, layerServices, make } from "./Agent.ts"
import { pretty } from "./OutputFormatter.ts"
import { LanguageModel, Prompt } from "effect/unstable/ai"
import * as Model from "effect/unstable/ai/Model"

const usage = {
  inputTokens: {
    uncached: undefined,
    total: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: undefined,
    text: undefined,
    reasoning: undefined,
  },
}

const promptText = (prompt: Prompt.Prompt) =>
  prompt.content
    .flatMap((message) => {
      if (typeof message.content === "string") {
        return [message.content]
      }
      return message.content.flatMap((part) => {
        switch (part.type) {
          case "text":
          case "reasoning":
            return [part.text]

          default:
            return []
        }
      })
    })
    .join("\n")

const scriptResponse = (script: string) =>
  Stream.fromIterable([
    { type: "text-start", id: "script" } as const,
    { type: "text-delta", id: "script", delta: script } as const,
    { type: "text-end", id: "script" } as const,
    {
      type: "finish",
      reason: "stop",
      usage,
      response: undefined,
    } as const,
  ])

const TestModel = Model.make(
  "test-provider",
  "test-model",
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: ({ prompt }) => {
        const text = promptText(prompt)

        if (text.includes("grandchild task")) {
          return scriptResponse(
            [
              'console.log("grandchild output")',
              'await taskComplete("grandchild summary")',
            ].join("\n"),
          )
        }

        if (text.includes("child task")) {
          return scriptResponse(
            [
              'const result = await delegate("grandchild task")',
              "await taskComplete(`child summary: ${result}`)",
            ].join("\n"),
          )
        }

        return scriptResponse(
          [
            'const result = await delegate("child task")',
            "await taskComplete(`root summary: ${result}`)",
          ].join("\n"),
        )
      },
    }),
  ),
)

describe("Agent", () => {
  it.effect("forwards nested subagent output", () =>
    Effect.gen(function* () {
      const seen = [] as Array<string>
      const agent = yield* make({
        directory: process.cwd(),
        prompt: "root task",
      })

      const output = yield* agent.output.pipe(
        Stream.tap((part) =>
          Effect.sync(() => {
            switch (part._tag) {
              case "SubagentStart":
              case "SubagentComplete":
                seen.push(`${part._tag}:${part.id}`)
                break

              case "SubagentPart":
                seen.push(`${part._tag}:${part.id}:${part.part._tag}`)
                break

              default:
                seen.push(part._tag)
                break
            }
          }),
        ),
        pretty,
        Stream.mkString,
      )

      expect(seen).toContain("SubagentStart:1")
      expect(seen).toContain("SubagentStart:2")
      expect(seen).toContain("SubagentPart:2:ScriptStart")
      expect(seen).toContain("SubagentPart:2:ScriptOutput")
      expect(seen).toContain("SubagentComplete:2")
      expect(seen).toContain("SubagentComplete:1")

      expect(output).toContain("Subagent #1 starting")
      expect(output).toContain("Subagent #2 starting")
      expect(output).toContain("grandchild output")
      expect(output).toContain("Subagent #2 complete")
      expect(output).toContain("Task complete:")
      expect(output).toContain(
        "root summary: child summary: grandchild summary",
      )
    }).pipe(
      Effect.provide([
        layerServices,
        TestModel,
        AgentModelConfig.layer({
          supportsNoTools: true,
        }),
      ]),
      Effect.provide(NodeServices.layer),
    ),
  )
})

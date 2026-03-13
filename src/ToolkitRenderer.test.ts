import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { AgentTools } from "./AgentTools.ts"
import { ToolkitRenderer } from "./ToolkitRenderer.ts"

describe("ToolkitRenderer", () => {
  it("renders bash with command options and optional timeout", async () => {
    const dts = await Effect.runPromise(
      Effect.gen(function* () {
        const renderer = yield* ToolkitRenderer
        return renderer.render(AgentTools)
      }).pipe(Effect.provide(ToolkitRenderer.layer)),
    )

    expect(dts).toContain("declare function bash(command: {")
    expect(dts).toContain("readonly command: string;")
    expect(dts).toContain("readonly timeout?: number | undefined;")
    expect(dts).toContain("Timeout in seconds (default: 120)")
  })
})

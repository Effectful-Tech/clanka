import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as AgentTools from "./AgentTools.ts"
import * as ToolkitRenderer from "./ToolkitRenderer.ts"

describe("ToolkitRenderer", () => {
  it.effect("renders the fetchJson tool signature", () =>
    Effect.gen(function* () {
      const toolkitRenderer = yield* ToolkitRenderer.ToolkitRenderer
      const dts = toolkitRenderer.render(AgentTools.AgentTools)
      assert.ok(
        dts.includes(
          "declare function fetchJson(url: string): Promise<unknown>",
        ),
      )
    }).pipe(Effect.provide(ToolkitRenderer.ToolkitRenderer.layer)),
  )
})

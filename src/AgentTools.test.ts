import { describe, expect, it } from "vitest"
import { normalizeBashTimeoutMs } from "./AgentTools.ts"

describe("normalizeBashTimeoutMs", () => {
  it("uses default timeout when timeoutMs is not provided", () => {
    expect(normalizeBashTimeoutMs(undefined)).toBe(120_000)
  })

  it("preserves timeoutMs when it is below the maximum", () => {
    expect(normalizeBashTimeoutMs(180_000)).toBe(180_000)
  })

  it("caps timeoutMs at four minutes", () => {
    expect(normalizeBashTimeoutMs(600_000)).toBe(240_000)
  })
})

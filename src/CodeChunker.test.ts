import { describe, expect, it } from "vitest"
import {
  chunkFileContent,
  isMeaningfulFile,
  isProbablyMinified,
} from "./CodeChunker.ts"

describe("isMeaningfulFile", () => {
  it("keeps source and documentation files", () => {
    expect(isMeaningfulFile("src/index.ts")).toBe(true)
    expect(isMeaningfulFile("README.md")).toBe(true)
    expect(isMeaningfulFile("docs/guide.mdx")).toBe(true)
  })

  it("filters lock files and minified artifacts", () => {
    expect(isMeaningfulFile("pnpm-lock.yaml")).toBe(false)
    expect(isMeaningfulFile("vendor/jquery.min.js")).toBe(false)
    expect(isMeaningfulFile("public/app.js.map")).toBe(false)
  })

  it("filters generated and dependency directories", () => {
    expect(isMeaningfulFile("node_modules/pkg/index.js")).toBe(false)
    expect(isMeaningfulFile("dist/index.js")).toBe(false)
    expect(isMeaningfulFile("coverage/index.html")).toBe(false)
  })
})

describe("isProbablyMinified", () => {
  it("detects very large single-line payloads", () => {
    expect(isProbablyMinified("x".repeat(2500))).toBe(true)
  })

  it("does not flag normal source content", () => {
    const source = [
      "export const a = 1",
      "export const b = 2",
      "export const c = 3",
    ].join("\n")
    expect(isProbablyMinified(source)).toBe(false)
  })
})

describe("chunkFileContent", () => {
  it("emits chunks with metadata and deterministic hashes", () => {
    const content = [
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
    ].join("\n")

    const chunks = chunkFileContent("src\\example.ts", content, {
      chunkSize: 3,
      chunkOverlap: 1,
    })

    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toMatchObject({
      path: "src/example.ts",
      startLine: 1,
      endLine: 3,
      content: ["line 1", "line 2", "line 3"].join("\n"),
    })
    expect(chunks[1]).toMatchObject({
      startLine: 3,
      endLine: 5,
      content: ["line 3", "line 4", "line 5"].join("\n"),
    })
    expect(chunks[2]).toMatchObject({
      startLine: 5,
      endLine: 6,
      content: ["line 5", "line 6"].join("\n"),
    })

    expect(chunks[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(chunks[0]?.contentHash).toBe(
      chunkFileContent("src/example.ts", content, {
        chunkSize: 3,
        chunkOverlap: 1,
      })[0]?.contentHash,
    )
  })

  it("skips non-meaningful chunk starts", () => {
    const content = [
      "",
      "   ",
      "---",
      "const alpha = 1",
      "const beta = 2",
    ].join("\n")

    const chunks = chunkFileContent("src/example.ts", content, {
      chunkSize: 3,
      chunkOverlap: 1,
    })

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      startLine: 4,
      endLine: 5,
      content: ["const alpha = 1", "const beta = 2"].join("\n"),
    })
  })

  it("drops minified-like content", () => {
    const chunks = chunkFileContent("src/bundle.js", "x".repeat(3000), {
      chunkSize: 30,
      chunkOverlap: 0,
    })
    expect(chunks).toEqual([])
  })
})

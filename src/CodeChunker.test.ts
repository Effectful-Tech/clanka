import { assert, describe, expect, it } from "@effect/vitest"
import {
  chunkFileContent,
  isMeaningfulFile,
  isProbablyMinified,
} from "./CodeChunker.ts"
import { readFileSync } from "node:fs"
import { join } from "node:path"

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
  it("splits TypeScript into AST chunks with metadata", () => {
    const content = [
      "// alpha docs",
      "export const alpha = 1",
      "// beta docs",
      "function beta() {",
      "  return alpha",
      "}",
      "class Example {",
      "  // gamma docs",
      "  gamma() {",
      "    return beta()",
      "  }",
      "}",
    ].join("\n")

    const chunks = chunkFileContent("src\\example.ts", content, {
      chunkSize: 10,
      chunkOverlap: 2,
    })

    expect(chunks).toHaveLength(4)
    expect(chunks[0]).toMatchObject({
      path: "src/example.ts",
      startLine: 1,
      endLine: 2,
      name: "alpha",
      type: "variable",
      parent: undefined,
      content: ["// alpha docs", "export const alpha = 1"].join("\n"),
    })
    expect(chunks[1]).toMatchObject({
      startLine: 3,
      endLine: 6,
      name: "beta",
      type: "function",
      parent: undefined,
      content: [
        "// beta docs",
        "function beta() {",
        "  return alpha",
        "}",
      ].join("\n"),
    })
    expect(chunks[2]).toMatchObject({
      startLine: 7,
      endLine: 12,
      name: "Example",
      type: "class",
      parent: undefined,
      content: [
        "class Example {",
        "  // gamma docs",
        "  gamma() {",
        "    return beta()",
        "  }",
        "}",
      ].join("\n"),
    })
    expect(chunks[3]).toMatchObject({
      startLine: 8,
      endLine: 11,
      name: "gamma",
      type: "method",
      parent: "class Example",
      content: [
        "  // gamma docs",
        "  gamma() {",
        "    return beta()",
        "  }",
      ].join("\n"),
    })

    expect(
      chunkFileContent("src/example.ts", content, {
        chunkSize: 10,
        chunkOverlap: 2,
      })[0],
    ).toEqual(chunks[0])
  })

  it("splits large AST ranges using chunk settings", () => {
    const content = [
      "export function large() {",
      ...Array.from(
        { length: 60 },
        (_, index) =>
          "  const line" + String(index + 1) + " = " + String(index + 1),
      ),
      "}",
    ].join("\n")

    const chunks = chunkFileContent("src/large.ts", content, {
      chunkSize: 20,
      chunkOverlap: 5,
    })

    expect(chunks).toHaveLength(4)
    expect(chunks[0]).toMatchObject({
      startLine: 1,
      endLine: 20,
      name: "large",
      type: "function",
      parent: undefined,
    })
    expect(chunks[1]).toMatchObject({
      startLine: 16,
      endLine: 35,
    })
    expect(chunks[2]).toMatchObject({
      startLine: 31,
      endLine: 50,
    })
    expect(chunks[3]).toMatchObject({
      startLine: 46,
      endLine: 62,
    })
  })

  it("limits AST chunks by character count and drops punctuation-only segments", () => {
    const content = [
      "export function demo() {",
      "  const alpha = 1",
      "  const beta = 2",
      "  return alpha + beta",
      "}",
    ].join("\n")

    const chunks = chunkFileContent("src/demo.ts", content, {
      chunkSize: 20,
      chunkOverlap: 1,
      chunkMaxCharacters: 21,
    })

    expect(chunks).toHaveLength(4)
    expect(chunks).toMatchObject([
      {
        startLine: 1,
        endLine: 1,
        name: "demo",
        type: "function",
        content: "export function demo() {",
      },
      {
        startLine: 2,
        endLine: 2,
        name: "demo",
        type: "function",
        content: "  const alpha = 1",
      },
      {
        startLine: 3,
        endLine: 3,
        name: "demo",
        type: "function",
        content: "  const beta = 2",
      },
      {
        startLine: 4,
        endLine: 4,
        name: "demo",
        type: "function",
        content: "  return alpha + beta",
      },
    ])
  })

  it("limits line-window chunks by character count while preserving overlap", () => {
    const content = ["aaaaa", "bbbbb", "ccccc", "ddddd"].join("\n")

    const chunks = chunkFileContent("docs/notes.txt", content, {
      chunkSize: 4,
      chunkOverlap: 1,
      chunkMaxCharacters: 11,
    })

    expect(chunks).toHaveLength(3)
    expect(chunks).toMatchObject([
      {
        startLine: 1,
        endLine: 2,
        content: ["aaaaa", "bbbbb"].join("\n"),
      },
      {
        startLine: 2,
        endLine: 3,
        content: ["bbbbb", "ccccc"].join("\n"),
      },
      {
        startLine: 3,
        endLine: 4,
        content: ["ccccc", "ddddd"].join("\n"),
      },
    ])
  })

  it("keeps only the first oversized class segment when methods are present", () => {
    const content = [
      "class Example {",
      "  first() {",
      "    const a = 1",
      "    const b = 2",
      "    return a + b",
      "  }",
      "",
      "  second() {",
      "    const c = 3",
      "    const d = 4",
      "    return c + d",
      "  }",
      "}",
    ].join("\n")

    const chunks = chunkFileContent("src/example.ts", content, {
      chunkSize: 6,
      chunkOverlap: 1,
    })

    const classChunks = chunks.filter((chunk) => chunk.type === "class")
    expect(classChunks).toHaveLength(1)
    expect(classChunks[0]).toMatchObject({
      startLine: 1,
      endLine: 6,
      name: "Example",
      type: "class",
      parent: undefined,
    })

    expect(chunks.filter((chunk) => chunk.type === "method")).toMatchObject([
      {
        startLine: 2,
        endLine: 6,
        name: "first",
        parent: "class Example",
      },
      {
        startLine: 8,
        endLine: 12,
        name: "second",
        parent: "class Example",
      },
    ])
  })

  it("includes preceding comments in AST chunks", () => {
    const content = [
      "// alpha docs",
      "export const alpha = 1",
      "/**",
      " * beta docs",
      " */",
      "function beta() {",
      "  return alpha",
      "}",
      "class Example {",
      "  // gamma docs",
      "  gamma() {",
      "    return beta()",
      "  }",
      "}",
    ].join("\n")

    const chunks = chunkFileContent("src/example.ts", content, {
      chunkSize: 20,
      chunkOverlap: 2,
    })

    expect(chunks).toHaveLength(4)
    expect(chunks[0]).toMatchObject({
      startLine: 1,
      endLine: 2,
      name: "alpha",
      type: "variable",
      content: ["// alpha docs", "export const alpha = 1"].join("\n"),
    })
    expect(chunks[1]).toMatchObject({
      startLine: 3,
      endLine: 8,
      name: "beta",
      type: "function",
      content: [
        "/**",
        " * beta docs",
        " */",
        "function beta() {",
        "  return alpha",
        "}",
      ].join("\n"),
    })
    expect(chunks[3]).toMatchObject({
      startLine: 10,
      endLine: 13,
      name: "gamma",
      type: "method",
      parent: "class Example",
      content: [
        "  // gamma docs",
        "  gamma() {",
        "    return beta()",
        "  }",
      ].join("\n"),
    })
  })

  it("falls back to line windows for unsupported languages", () => {
    const content = [
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
    ].join("\n")

    const chunks = chunkFileContent("docs\\notes.txt", content, {
      chunkSize: 3,
      chunkOverlap: 1,
    })

    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toMatchObject({
      path: "docs/notes.txt",
      startLine: 1,
      endLine: 3,
      name: undefined,
      type: undefined,
      parent: undefined,
      content: ["line 1", "line 2", "line 3"].join("\n"),
    })
    expect(chunks[1]).toMatchObject({
      startLine: 3,
      endLine: 5,
      name: undefined,
      type: undefined,
      parent: undefined,
      content: ["line 3", "line 4", "line 5"].join("\n"),
    })
    expect(chunks[2]).toMatchObject({
      startLine: 5,
      endLine: 6,
      name: undefined,
      type: undefined,
      parent: undefined,
      content: ["line 5", "line 6"].join("\n"),
    })
  })

  it("drops minified-like content", () => {
    const chunks = chunkFileContent("src/bundle.js", "x".repeat(3000), {
      chunkSize: 30,
      chunkOverlap: 0,
    })
    expect(chunks).toEqual([])
  })

  it("seperates class methods into their own chunks", () => {
    const fixture = readFileSync(
      join(__dirname, "fixtures", "fiber.txt"),
      "utf-8",
    )
    const chunks = chunkFileContent("src/fiber.ts", fixture, {
      chunkSize: 30,
      chunkOverlap: 0,
    })
    const runLoopChunk = chunks.find((chunk) => chunk.name === "runLoop")
    assert(runLoopChunk, "Expected to find a chunk for the runLoop method")
    assert.strictEqual(runLoopChunk.type, "method")
  })

  it("chunks ts namespaces", () => {
    const fixture = readFileSync(
      join(__dirname, "fixtures", "yieldable.txt"),
      "utf-8",
    )
    const chunks = chunkFileContent("src/Effect.ts", fixture, {
      chunkSize: 30,
      chunkOverlap: 0,
    })
    const names = chunks.map((chunk) => chunk.name)
    assert.deepStrictEqual(names, ["Yieldable", "Any", "Success"])
    const parents = chunks.map((chunk) => chunk.parent)
    assert.deepStrictEqual(parents, [
      undefined,
      "namespace Yieldable",
      "namespace Yieldable",
    ])
  })
})

import { assert, describe, it } from "@effect/vitest"
import { preprocessScript } from "./ScriptPreprocessing.ts"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const tick = "`"
const escaped = "\\`"
const escapedInterpolation = "\\${"
const wrapTemplate = (value: string): string => `${tick}${value}${tick}`

describe("preprocessScript", () => {
  it("escapes internal backticks in applyPatch templates", () => {
    const input = [
      "await applyPatch(`",
      "*** Begin Patch",
      "*** Update File: src/example.ts",
      "@@",
      "-const oldValue = `old`",
      "+const newValue = `new`",
      "*** End Patch",
      "`)",
    ].join("\n")

    const output = preprocessScript(input)

    assert.strictEqual(
      output.includes(`-const oldValue = ${escaped}old${escaped}`),
      true,
    )
    assert.strictEqual(
      output.includes(`+const newValue = ${escaped}new${escaped}`),
      true,
    )
  })

  it("escapes internal interpolations in applyPatch templates", () => {
    const input = [
      "await applyPatch(`",
      "*** Begin Patch",
      "*** Update File: src/example.ts",
      "@@",
      "+const value = ${nextValue}",
      "*** End Patch",
      "`)",
    ].join("\n")

    const output = preprocessScript(input)

    assert.strictEqual(
      output.includes(`+const value = ${escapedInterpolation}nextValue}`),
      true,
    )
  })

  it("escapes internal backticks in writeFile content templates", () => {
    const input = [
      "await writeFile({",
      '  path: "src/example.ts",',
      "  content: `const value = `next``,",
      "})",
    ].join("\n")

    const output = preprocessScript(input)

    assert.strictEqual(
      output.includes(
        `content: ${wrapTemplate(`const value = ${escaped}next${escaped}`)},`,
      ),
      true,
    )
  })

  it("escapes internal backticks in taskComplete templates", () => {
    const input = "await taskComplete(`Implemented `TypeBuilder` updates.`)"

    const output = preprocessScript(input)

    assert.strictEqual(
      output,
      `await taskComplete(${wrapTemplate(`Implemented ${escaped}TypeBuilder${escaped} updates.`)})`,
    )
  })

  it("does not change scripts when target templates are already escaped", () => {
    const input = [
      `await applyPatch(${wrapTemplate(`const value = ${escaped}safe${escaped}`)})`,
      `await applyPatch(${wrapTemplate(`const value = ${escapedInterpolation}safe}`)})`,
      `await writeFile({ path: "src/example.ts", content: ${wrapTemplate(`already ${escaped}safe${escaped}`)} })`,
      `await taskComplete(${wrapTemplate(`All done with ${escaped}safe${escaped} backticks.`)})`,
    ].join("\n")

    assert.strictEqual(preprocessScript(input), input)
  })

  it("does not modify non-target function calls", () => {
    const input = "await otherTool(`Keep `this` untouched.`)"

    assert.strictEqual(preprocessScript(input), input)
  })

  it("escapes internal backticks in applyPatch templates assigned to variables", () => {
    const input = [
      "const patch = `*** Begin Patch",
      "*** Update File: src/example.ts",
      "@@",
      "-const oldValue = `old`",
      "+const newValue = `new`",
      "*** End Patch`;",
      "await applyPatch(patch)",
    ].join("\n")

    const output = preprocessScript(input)

    assert.strictEqual(
      output.includes(`-const oldValue = ${escaped}old${escaped}`),
      true,
    )
    assert.strictEqual(
      output.includes(`+const newValue = ${escaped}new${escaped}`),
      true,
    )
  })

  it("escapes internal backticks in taskComplete templates assigned to variables", () => {
    const input = [
      "const summary = `Implemented `TypeBuilder` updates.`;",
      "await taskComplete(summary)",
    ].join("\n")

    const output = preprocessScript(input)

    assert.strictEqual(
      output,
      [
        `const summary = ${wrapTemplate(`Implemented ${escaped}TypeBuilder${escaped} updates.`)};`,
        "await taskComplete(summary)",
      ].join("\n"),
    )
  })

  it("escapes internal backticks in writeFile content assigned to variables", () => {
    const input = [
      "const body = `const value = `next``;",
      "await writeFile({",
      '  path: "src/example.ts",',
      "  content: body,",
      "})",
    ].join("\n")

    const output = preprocessScript(input)

    assert.strictEqual(
      output.includes(
        `const body = ${wrapTemplate(`const value = ${escaped}next${escaped}`)};`,
      ),
      true,
    )
  })

  it.each(["patch", "patch2"])("fixes broken %s", (fixture) => {
    const content = readFileSync(
      join(__dirname, "fixtures", `${fixture}-broken.txt`),
      "utf-8",
    )
    const fixed = readFileSync(
      join(__dirname, "fixtures", `${fixture}-fixed.txt`),
      "utf-8",
    )
    assert.equal(preprocessScript(content), fixed)
  })
})

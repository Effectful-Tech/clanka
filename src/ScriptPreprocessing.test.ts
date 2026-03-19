import { assert, describe, it } from "@effect/vitest"
import { preprocessScript } from "./ScriptPreprocessing.ts"

const tick = "`"
const escaped = "\\`"
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
      `await writeFile({ path: "src/example.ts", content: ${wrapTemplate(`already ${escaped}safe${escaped}`)} })`,
      `await taskComplete(${wrapTemplate(`All done with ${escaped}safe${escaped} backticks.`)})`,
    ].join("\n")

    assert.strictEqual(preprocessScript(input), input)
  })

  it("does not modify non-target function calls", () => {
    const input = "await otherTool(`Keep `this` untouched.`)"

    assert.strictEqual(preprocessScript(input), input)
  })
})

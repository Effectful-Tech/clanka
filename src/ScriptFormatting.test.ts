import { describe, expect, it } from "@effect/vitest"
import { formatScript } from "./ScriptFormatting.ts"

describe("formatScript", () => {
  it("formats scripts larger than the parser default buffer", () => {
    const declaration = `const data="${"x".repeat(40_000)}";`
    expect(formatScript(declaration + "console.log(data);")).toBe(
      declaration + "\nconsole.log(data);",
    )
  })

  it("adds line breaks to compact statements and blocks without expanding for headers", () => {
    const input = "let n=0;for(let i=0;i<2;i++){n+=i;}console.log(n);"
    const output = "let n=0;\nfor(let i=0;i<2;i++){\nn+=i;\n}\nconsole.log(n);"
    expect(formatScript(input)).toBe(output)
    expect(formatScript(output)).toBe(output)
  })

  it("preserves literals, comments, and line-sensitive expressions", () => {
    const input = [
      `const text="😀;{}";const re=/[;{}]/g;`,
      "const template=`raw;{} ${(() => { return 1; })()}`;",
      "// comment ;{}",
      "const obj={value: 1};/* comment ;{} */obj.value++;",
      "function f(){return {value: 1};}console.log(text, re, template, f());",
    ].join("\n")
    const output = formatScript(input)
    expect(output).toContain(`const text="😀;{}";\nconst re=/[;{}]/g;`)
    expect(output).toContain("`raw;{} ${(() => { return 1; })()}`")
    expect(output).toContain("// comment ;{}\n")
    expect(output).toContain("/* comment ;{} */")
    expect(output).toContain("return {value: 1};")
  })

  it("leaves incomplete scripts and existing whitespace alone", () => {
    expect(formatScript("const x = {;")).toBe("const x = {;")
    const input = "if (true) {\r\n  console.log(1);\r\n}\r\n"
    expect(formatScript(input)).toBe(input)
  })
})

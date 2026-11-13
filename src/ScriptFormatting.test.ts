import { describe, expect, it } from "@effect/vitest"
import { formatScript } from "./ScriptFormatting.ts"

describe("formatScript", () => {
  it("removes separator spaces only at inserted line breaks", () => {
    const input = [
      "console.log(await ls('.')); console.log(await readFile({path: 'README.md'}));\t console.log(await readFile({path: 'package.json'}));",
      'if (true) {  console.log("  literal;  "); /*  comment;  */ console.log(`  template;  `); }',
      "if (true) {",
      "  console.log(1);",
      "\tconsole.log(2);",
      "}",
    ].join("\n")
    const expected = [
      "console.log(await ls('.'));",
      "console.log(await readFile({path: 'README.md'}));",
      "console.log(await readFile({path: 'package.json'}));",
      "if (true) {",
      'console.log("  literal;  ");',
      "/*  comment;  */ console.log(`  template;  `);",
      "}",
      "if (true) {",
      "  console.log(1);",
      "\tconsole.log(2);",
      "}",
    ].join("\n")
    expect(formatScript(input)).toBe(expected)
    expect(formatScript(expected)).toBe(expected)
  })

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

  it("breaks statement blocks but not the expressions around them", () => {
    const input = "const a=b/2;if(a){x()}else{y()}run(function(){go();});"
    const output =
      "const a=b/2;\nif(a){\nx()\n}else{\ny()\n}\nrun(function(){\ngo();\n});"
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
    expect(formatScript("n=a.in/2;re=/x;y/;")).toBe("n=a.in/2;\nre=/x;y/;")
    // A slash after ")" may start a regex or divide, so nothing is changed.
    for (const input of [
      "if (a) /x;y/.test(s);n=1;",
      "for await (const x of []) /x;y/.test(s);n=1;",
      "n=obj.with()/2;re=/x;y/;",
    ]) {
      expect(formatScript(input)).toBe(input)
    }
  })

  it("leaves incomplete scripts and existing whitespace alone", () => {
    expect(formatScript("const x = {;")).toBe("const x = {;")
    expect(formatScript("const x=1; /* unfinished")).toBe(
      "const x=1; /* unfinished",
    )
    const input = "if (true) {\r\n  console.log(1);\r\n}\r\n"
    expect(formatScript(input)).toBe(input)
  })
})

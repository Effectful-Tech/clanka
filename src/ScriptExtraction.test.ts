import { describe, expect, it } from "vitest"
import { extractScript, stripWrappingCodeFence } from "./ScriptExtraction.ts"

describe("extractScript", () => {
  it("returns the full string when there are no code blocks", () => {
    const markdown = [
      "This is some text.",
      "",
      "There are no fenced code blocks here.",
    ].join("\n")

    expect(extractScript(markdown)).toBe(markdown)
  })

  it("extracts a single fenced code block", () => {
    expect(
      extractScript(
        [
          "Before",
          "",
          "```ts",
          'console.log("Hello, world!")',
          "```",
          "",
          "After",
        ].join("\n"),
      ),
    ).toBe('console.log("Hello, world!")')
  })

  it("concatenates multiple fenced code blocks", () => {
    expect(
      extractScript(
        [
          "Before",
          "",
          "```js",
          'console.log("Hello, world!")',
          "```",
          "",
          "Between",
          "",
          "```",
          'console.log("Goodbye, world!")',
          "```",
        ].join("\n"),
      ),
    ).toBe(
      ['console.log("Hello, world!")', 'console.log("Goodbye, world!")'].join(
        "\n\n",
      ),
    )
  })

  it("supports longer fences", () => {
    expect(
      extractScript(
        ["````md", "```ts", 'console.log("nested")', "```", "````"].join("\n"),
      ),
    ).toBe(["```ts", 'console.log("nested")', "```"].join("\n"))
  })

  it("supports empty fenced code blocks", () => {
    expect(extractScript(["```ts", "```"].join("\n"))).toBe("")
  })

  it("supports unclosed fenced code blocks", () => {
    expect(
      extractScript(["before", "", "```ts", "const answer = 42"].join("\n")),
    ).toBe("const answer = 42")
  })

  it("supports closing fences longer than the opening fence", () => {
    expect(
      extractScript(["```ts", "const answer = 42", "````"].join("\n")),
    ).toBe("const answer = 42")
  })

  it("preserves CRLF output when extracting multiple blocks", () => {
    expect(
      extractScript(
        [
          "Before",
          "",
          "```ts",
          "const a = 1",
          "```",
          "",
          "```ts",
          "const b = 2",
          "```",
        ].join("\r\n"),
      ),
    ).toBe(["const a = 1", "const b = 2"].join("\r\n\r\n"))
  })

  it("supports tilde fences", () => {
    expect(
      extractScript(["~~~ts", 'console.log("tilde")', "~~~"].join("\n")),
    ).toBe('console.log("tilde")')
  })

  it("does not close a backtick fence with tildes", () => {
    expect(
      extractScript(["```", "hello", "~~~", "world", "```"].join("\n")),
    ).toBe(["hello", "~~~", "world"].join("\n"))
  })

  it("does not close a tilde fence with backticks", () => {
    expect(
      extractScript(["~~~", "hello", "```", "world", "~~~"].join("\n")),
    ).toBe(["hello", "```", "world"].join("\n"))
  })

  it("does not close when closing fence is shorter than opening", () => {
    expect(
      extractScript(["````", "hello", "```", "world", "````"].join("\n")),
    ).toBe(["hello", "```", "world"].join("\n"))
  })

  it("supports fences with up to three leading spaces", () => {
    expect(extractScript(["  ```ts", "const a = 1", "  ```"].join("\n"))).toBe(
      "const a = 1",
    )
  })

  it("does not treat a closing fence with trailing text as closing", () => {
    expect(
      extractScript(
        ["```", "hello", "``` more text", "world", "```"].join("\n"),
      ),
    ).toBe(["hello", "``` more text", "world"].join("\n"))
  })
})

describe("stripWrappingCodeFence", () => {
  it("strips wrapping backtick fences", () => {
    expect(
      stripWrappingCodeFence(["```ts", "const answer = 42", "```"].join("\n")),
    ).toBe("const answer = 42")
  })

  it("strips wrapping tilde fences", () => {
    expect(
      stripWrappingCodeFence(["~~~js", "console.log(1)", "~~~"].join("\n")),
    ).toBe("console.log(1)")
  })

  it("preserves CRLF output when stripping wrappers", () => {
    expect(
      stripWrappingCodeFence(
        ["```ts", "const a = 1", "const b = 2", "```"].join("\r\n"),
      ),
    ).toBe(["const a = 1", "const b = 2"].join("\r\n"))
  })

  it("returns the input unchanged when not fully wrapped", () => {
    const input = [
      "Some explanation",
      "",
      "```ts",
      "const answer = 42",
      "```",
    ].join("\n")
    expect(stripWrappingCodeFence(input)).toBe(input)
  })

  it("returns the input unchanged when closing fence is missing", () => {
    const input = ["```ts", "const answer = 42"].join("\n")
    expect(stripWrappingCodeFence(input)).toBe(input)
  })

  it("returns the input unchanged when fence markers do not match", () => {
    const input = ["```ts", "const answer = 42", "~~~"].join("\n")
    expect(stripWrappingCodeFence(input)).toBe(input)
  })
})

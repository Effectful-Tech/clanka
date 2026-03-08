import { describe, expect, it } from "vitest"
import { parsePatch, patchContent } from "./ApplyPatch.ts"

describe("patchContent", () => {
  it("applies raw hunks", () => {
    expect(
      patchContent("sample.txt", "line1\nline2\n", "@@\n-line2\n+changed"),
    ).toBe("line1\nchanged\n")
  })

  it("does not treat raw marker text as a wrapped patch", () => {
    expect(
      patchContent(
        "sample.txt",
        "*** Begin Patch\nfinish\n",
        "@@\n-*** Begin Patch\n+*** End Patch",
      ),
    ).toBe("*** End Patch\nfinish\n")
  })

  it("parses wrapped single-file patches", () => {
    expect(
      patchContent(
        "sample.txt",
        "alpha\nomega\n",
        "*** Begin Patch\n*** Update File: ignored.txt\n@@\n alpha\n+beta\n omega\n*** End Patch",
      ),
    ).toBe("alpha\nbeta\nomega\n")
  })

  it("parses multi-file wrapped patches", () => {
    expect(
      parsePatch(
        [
          "*** Begin Patch",
          "*** Add File: hello.txt",
          "+Hello world",
          "*** Update File: src/app.ts",
          "*** Move to: src/main.ts",
          "@@ keep",
          " keep",
          "-old",
          "+new",
          "*** Delete File: obsolete.txt",
          "*** End Patch",
        ].join("\n"),
      ),
    ).toEqual([
      {
        type: "add",
        path: "hello.txt",
        content: "Hello world",
      },
      {
        type: "update",
        path: "src/app.ts",
        movePath: "src/main.ts",
        chunks: [
          {
            ctx: "keep",
            old: ["keep", "old"],
            next: ["keep", "new"],
          },
        ],
      },
      {
        type: "delete",
        path: "obsolete.txt",
      },
    ])
  })

  it("parses heredoc-wrapped hunks", () => {
    expect(
      patchContent("sample.txt", "old\n", "<<'EOF'\n@@\n-old\n+new\nEOF"),
    ).toBe("new\n")
  })

  it("matches lines after trimming trailing whitespace", () => {
    expect(patchContent("sample.txt", "old  \n", "@@\n-old\n+new")).toBe(
      "new\n",
    )
  })

  it("matches lines after trimming surrounding whitespace", () => {
    expect(patchContent("sample.txt", "  old\n", "@@\n-old\n+new")).toBe(
      "new\n",
    )
  })

  it("matches lines after normalizing Unicode punctuation", () => {
    expect(
      patchContent("sample.txt", "Don’t wait…\n", "@@\n-Don't wait...\n+Done"),
    ).toBe("Done\n")
  })

  it("matches EOF hunks from the end of the file", () => {
    expect(
      patchContent(
        "tail.txt",
        "start\nmarker\nend\nmiddle\nmarker\nend\n",
        "@@\n-marker\n-end\n+marker-changed\n+end\n*** End of File",
      ),
    ).toBe("start\nmarker\nend\nmiddle\nmarker-changed\nend\n")
  })

  it("preserves CRLF files", () => {
    expect(patchContent("crlf.txt", "old\r\n", "@@\n-old\n+new")).toBe(
      "new\r\n",
    )
  })

  it("rejects multi-file wrapped patches", () => {
    expect(() =>
      patchContent(
        "sample.txt",
        "line1\nline2\n",
        "*** Begin Patch\n*** Update File: a.txt\n@@\n-line2\n+changed\n*** Update File: b.txt\n@@\n-old\n+new\n*** End Patch",
      ),
    ).toThrow("only one update file section is supported")
  })
})

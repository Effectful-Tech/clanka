import { describe, expect, it } from "vitest"
import { patchContent } from "./ApplyPatch.ts"

describe("patchContent", () => {
  it("applies raw hunks", () => {
    expect(
      patchContent("sample.txt", "line1\nline2\n", "@@\n-line2\n+changed"),
    ).toBe("line1\nchanged\n")
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

  it("matches EOF hunks from the end of the file", () => {
    expect(
      patchContent(
        "tail.txt",
        "start\nmarker\nmiddle\nmarker\nend\n",
        "@@\n-marker\n-end\n+marker-changed\n+end\n*** End of File",
      ),
    ).toBe("start\nmarker\nmiddle\nmarker-changed\nend\n")
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

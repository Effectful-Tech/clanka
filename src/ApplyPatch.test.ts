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

  it("parses wrapped patches when hunks contain marker text", () => {
    expect(
      parsePatch(
        [
          "*** Begin Patch",
          "*** Update File: src/app.ts",
          "@@",
          " *** End Patch",
          "-old",
          "+new",
          "*** Delete File: obsolete.txt",
          "*** End Patch",
        ].join("\n"),
      ),
    ).toEqual([
      {
        type: "update",
        path: "src/app.ts",
        chunks: [
          {
            old: ["*** End Patch", "old"],
            next: ["*** End Patch", "new"],
          },
        ],
      },
      {
        type: "delete",
        path: "obsolete.txt",
      },
    ])
  })

  it("parses multi-file git diffs with add, rename, and delete", () => {
    expect(
      parsePatch(
        [
          "diff --git a/src/app.ts b/src/app.ts",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "diff --git a/obsolete.txt b/obsolete.txt",
          "deleted file mode 100644",
          "--- a/obsolete.txt",
          "+++ /dev/null",
          "diff --git a/src/old.ts b/src/new.ts",
          "similarity index 100%",
          "rename from src/old.ts",
          "rename to src/new.ts",
          "--- a/src/old.ts",
          "+++ b/src/new.ts",
          "@@ -1 +1 @@",
          "-before",
          "+after",
          "diff --git a/dev/null b/notes/hello.txt",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/notes/hello.txt",
          "@@ -0,0 +1 @@",
          "+Hello world",
        ].join("\n"),
      ),
    ).toEqual([
      {
        type: "update",
        path: "src/app.ts",
        chunks: [
          {
            old: ["old"],
            next: ["new"],
          },
        ],
      },
      {
        type: "delete",
        path: "obsolete.txt",
      },
      {
        type: "update",
        path: "src/old.ts",
        movePath: "src/new.ts",
        chunks: [
          {
            old: ["before"],
            next: ["after"],
          },
        ],
      },
      {
        type: "add",
        path: "notes/hello.txt",
        content: "Hello world\n",
      },
    ])
  })

  it("parses unified diffs without a diff --git header", () => {
    expect(
      parsePatch(
        [
          "--- a/sample.txt",
          "+++ b/sample.txt",
          "@@ -1 +1,2 @@",
          " alpha",
          "+beta",
        ].join("\n"),
      ),
    ).toEqual([
      {
        type: "update",
        path: "sample.txt",
        chunks: [
          {
            old: ["alpha"],
            next: ["alpha", "beta"],
          },
        ],
      },
    ])
  })

  it("parses larger realistic multi-file unified diffs", () => {
    expect(
      parsePatch(
        [
          "diff --git a/dist/index.js b/dist/index.js",
          "index f33510a..e887a60 100644",
          "--- a/dist/index.js",
          "+++ b/dist/index.js",
          "@@ -1,7 +1,12 @@",
          " if (reasoningStarted && !textStarted) {",
          "   controller.enqueue({",
          '     type: "reasoning-end",',
          "-    id: reasoningId || generateId()",
          "+    id: reasoningId || generateId(),",
          "+    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
          "+      openrouter: {",
          "+        reasoning_details: accumulatedReasoningDetails",
          "+      }",
          "+    } : undefined",
          "   });",
          " }",
          "@@ -20,7 +25,12 @@",
          " if (reasoningStarted) {",
          "   controller.enqueue({",
          '     type: "reasoning-end",',
          "-    id: reasoningId || generateId()",
          "+    id: reasoningId || generateId(),",
          "+    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
          "+      openrouter: {",
          "+        reasoning_details: accumulatedReasoningDetails",
          "+      }",
          "+    } : undefined",
          "   });",
          " }",
          "diff --git a/dist/index.mjs b/dist/index.mjs",
          "index 8a68833..6310cb8 100644",
          "--- a/dist/index.mjs",
          "+++ b/dist/index.mjs",
          "@@ -1,7 +1,12 @@",
          " if (reasoningStarted && !textStarted) {",
          "   controller.enqueue({",
          '     type: "reasoning-end",',
          "-    id: reasoningId || generateId()",
          "+    id: reasoningId || generateId(),",
          "+    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
          "+      openrouter: {",
          "+        reasoning_details: accumulatedReasoningDetails",
          "+      }",
          "+    } : undefined",
          "   });",
          " }",
          "@@ -20,7 +25,12 @@",
          " if (reasoningStarted) {",
          "   controller.enqueue({",
          '     type: "reasoning-end",',
          "-    id: reasoningId || generateId()",
          "+    id: reasoningId || generateId(),",
          "+    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
          "+      openrouter: {",
          "+        reasoning_details: accumulatedReasoningDetails",
          "+      }",
          "+    } : undefined",
          "   });",
          " }",
          "diff --git a/dist/internal/index.js b/dist/internal/index.js",
          "index d40fa66..8dd86d1 100644",
          "--- a/dist/internal/index.js",
          "+++ b/dist/internal/index.js",
          "@@ -1,7 +1,12 @@",
          " if (reasoningStarted && !textStarted) {",
          "   controller.enqueue({",
          '     type: "reasoning-end",',
          "-    id: reasoningId || generateId()",
          "+    id: reasoningId || generateId(),",
          "+    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
          "+      openrouter: {",
          "+        reasoning_details: accumulatedReasoningDetails",
          "+      }",
          "+    } : undefined",
          "   });",
          " }",
          "@@ -20,7 +25,12 @@",
          " if (reasoningStarted) {",
          "   controller.enqueue({",
          '     type: "reasoning-end",',
          "-    id: reasoningId || generateId()",
          "+    id: reasoningId || generateId(),",
          "+    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
          "+      openrouter: {",
          "+        reasoning_details: accumulatedReasoningDetails",
          "+      }",
          "+    } : undefined",
          "   });",
          " }",
          "diff --git a/dist/internal/index.mjs b/dist/internal/index.mjs",
          "index b0ed9d1..5695930 100644",
          "--- a/dist/internal/index.mjs",
          "+++ b/dist/internal/index.mjs",
          "@@ -1,7 +1,12 @@",
          " if (reasoningStarted && !textStarted) {",
          "   controller.enqueue({",
          '     type: "reasoning-end",',
          "-    id: reasoningId || generateId()",
          "+    id: reasoningId || generateId(),",
          "+    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
          "+      openrouter: {",
          "+        reasoning_details: accumulatedReasoningDetails",
          "+      }",
          "+    } : undefined",
          "   });",
          " }",
          "@@ -20,7 +25,12 @@",
          " if (reasoningStarted) {",
          "   controller.enqueue({",
          '     type: "reasoning-end",',
          "-    id: reasoningId || generateId()",
          "+    id: reasoningId || generateId(),",
          "+    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
          "+      openrouter: {",
          "+        reasoning_details: accumulatedReasoningDetails",
          "+      }",
          "+    } : undefined",
          "   });",
          " }",
        ].join("\n"),
      ),
    ).toEqual([
      {
        type: "update",
        path: "dist/index.js",
        chunks: [
          {
            old: [
              "if (reasoningStarted && !textStarted) {",
              "  controller.enqueue({",
              '    type: "reasoning-end",',
              "    id: reasoningId || generateId()",
              "  });",
              "}",
            ],
            next: [
              "if (reasoningStarted && !textStarted) {",
              "  controller.enqueue({",
              '    type: "reasoning-end",',
              "    id: reasoningId || generateId(),",
              "    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
              "      openrouter: {",
              "        reasoning_details: accumulatedReasoningDetails",
              "      }",
              "    } : undefined",
              "  });",
              "}",
            ],
          },
          {
            old: [
              "if (reasoningStarted) {",
              "  controller.enqueue({",
              '    type: "reasoning-end",',
              "    id: reasoningId || generateId()",
              "  });",
              "}",
            ],
            next: [
              "if (reasoningStarted) {",
              "  controller.enqueue({",
              '    type: "reasoning-end",',
              "    id: reasoningId || generateId(),",
              "    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
              "      openrouter: {",
              "        reasoning_details: accumulatedReasoningDetails",
              "      }",
              "    } : undefined",
              "  });",
              "}",
            ],
          },
        ],
      },
      {
        type: "update",
        path: "dist/index.mjs",
        chunks: [
          {
            old: [
              "if (reasoningStarted && !textStarted) {",
              "  controller.enqueue({",
              '    type: "reasoning-end",',
              "    id: reasoningId || generateId()",
              "  });",
              "}",
            ],
            next: [
              "if (reasoningStarted && !textStarted) {",
              "  controller.enqueue({",
              '    type: "reasoning-end",',
              "    id: reasoningId || generateId(),",
              "    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
              "      openrouter: {",
              "        reasoning_details: accumulatedReasoningDetails",
              "      }",
              "    } : undefined",
              "  });",
              "}",
            ],
          },
          {
            old: [
              "if (reasoningStarted) {",
              "  controller.enqueue({",
              '    type: "reasoning-end",',
              "    id: reasoningId || generateId()",
              "  });",
              "}",
            ],
            next: [
              "if (reasoningStarted) {",
              "  controller.enqueue({",
              '    type: "reasoning-end",',
              "    id: reasoningId || generateId(),",
              "    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
              "      openrouter: {",
              "        reasoning_details: accumulatedReasoningDetails",
              "      }",
              "    } : undefined",
              "  });",
              "}",
            ],
          },
        ],
      },
      {
        type: "update",
        path: "dist/internal/index.js",
        chunks: [
          {
            old: [
              "if (reasoningStarted && !textStarted) {",
              "  controller.enqueue({",
              '    type: "reasoning-end",',
              "    id: reasoningId || generateId()",
              "  });",
              "}",
            ],
            next: [
              "if (reasoningStarted && !textStarted) {",
              "  controller.enqueue({",
              '    type: "reasoning-end",',
              "    id: reasoningId || generateId(),",
              "    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
              "      openrouter: {",
              "        reasoning_details: accumulatedReasoningDetails",
              "      }",
              "    } : undefined",
              "  });",
              "}",
            ],
          },
          {
            old: [
              "if (reasoningStarted) {",
              "  controller.enqueue({",
              '    type: "reasoning-end",',
              "    id: reasoningId || generateId()",
              "  });",
              "}",
            ],
            next: [
              "if (reasoningStarted) {",
              "  controller.enqueue({",
              '    type: "reasoning-end",',
              "    id: reasoningId || generateId(),",
              "    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
              "      openrouter: {",
              "        reasoning_details: accumulatedReasoningDetails",
              "      }",
              "    } : undefined",
              "  });",
              "}",
            ],
          },
        ],
      },
      {
        type: "update",
        path: "dist/internal/index.mjs",
        chunks: [
          {
            old: [
              "if (reasoningStarted && !textStarted) {",
              "  controller.enqueue({",
              '    type: "reasoning-end",',
              "    id: reasoningId || generateId()",
              "  });",
              "}",
            ],
            next: [
              "if (reasoningStarted && !textStarted) {",
              "  controller.enqueue({",
              '    type: "reasoning-end",',
              "    id: reasoningId || generateId(),",
              "    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
              "      openrouter: {",
              "        reasoning_details: accumulatedReasoningDetails",
              "      }",
              "    } : undefined",
              "  });",
              "}",
            ],
          },
          {
            old: [
              "if (reasoningStarted) {",
              "  controller.enqueue({",
              '    type: "reasoning-end",',
              "    id: reasoningId || generateId()",
              "  });",
              "}",
            ],
            next: [
              "if (reasoningStarted) {",
              "  controller.enqueue({",
              '    type: "reasoning-end",',
              "    id: reasoningId || generateId(),",
              "    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
              "      openrouter: {",
              "        reasoning_details: accumulatedReasoningDetails",
              "      }",
              "    } : undefined",
              "  });",
              "}",
            ],
          },
        ],
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

  it("uses context to disambiguate repeated nearby matches", () => {
    expect(
      patchContent(
        "sample.txt",
        [
          "before",
          "target",
          "old",
          "between",
          "target",
          "old",
          "after",
          "",
        ].join("\n"),
        ["@@ target", " target", "-old", "+new"].join("\n"),
      ),
    ).toBe("before\ntarget\nold\nbetween\ntarget\nnew\nafter\n")
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

  it("rejects malformed multi-file git diffs without hunks", () => {
    expect(() =>
      parsePatch(
        [
          "diff --git a/src/app.ts b/src/app.ts",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
        ].join("\n"),
      ),
    ).toThrow("no hunks found for src/app.ts")
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

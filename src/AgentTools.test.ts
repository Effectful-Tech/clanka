import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeFileSystem, NodeServices } from "@effect/platform-node"
import { Deferred, Effect, FileSystem, Stream } from "effect"
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import {
  AgentToolHandlers,
  AgentTools,
  CurrentDirectory,
  makeContextNoop,
  TaskCompleteDeferred,
} from "./AgentTools.ts"
import { Executor } from "./Executor.ts"
import { ToolkitRenderer } from "./ToolkitRenderer.ts"

const makeTempRoot = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.makeTempDirectoryScoped({
      directory: tmpdir(),
      prefix,
    })
  })

describe("AgentTools", () => {
  it.effect("renders the tool signatures", () =>
    Effect.gen(function* () {
      const renderer = yield* ToolkitRenderer
      const output = renderer.render(AgentTools)

      expect(output).toContain(
        "/** Read a file and optionally filter the lines to return. Returns null if the file doesn't exist. */",
      )
      expect(output).toContain("declare function readFile(options: {")
      expect(output).toContain("readonly path: string;")
      expect(output).toContain("readonly startLine?: number | undefined;")
      expect(output).toContain("readonly endLine?: number | undefined;")
      expect(output).toContain(
        "/** Apply a git diff / unified diff patch, or a wrapped apply_patch patch, across one or more files. */",
      )
      expect(output).toContain(
        "declare function applyPatch(patch: string): Promise<string>",
      )
      expect(output).not.toContain("declare function python(")
    }).pipe(
      Effect.provide([
        AgentToolHandlers,
        Executor.layer,
        ToolkitRenderer.layer,
      ]),
      Effect.provide(NodeServices.layer),
      Effect.provideService(CurrentDirectory, process.cwd()),
      Effect.provideServiceEffect(
        TaskCompleteDeferred,
        Deferred.make<string>(),
      ),
    ),
  )

  it.effect("applies multi-file patches with add, move, and delete", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tempRoot = yield* makeTempRoot("clanka-apply-patch-")
      yield* fs.makeDirectory(join(tempRoot, "src"), { recursive: true })
      yield* fs.writeFileString(join(tempRoot, "src", "app.txt"), "old\n")
      yield* fs.writeFileString(join(tempRoot, "obsolete.txt"), "remove me\n")

      const executor = yield* Executor
      const tools = yield* AgentTools
      const output = yield* executor
        .execute({
          tools,
          script: [
            "const output = await applyPatch(`",
            "diff --git a/src/app.txt b/src/main.txt",
            "similarity index 100%",
            "rename from src/app.txt",
            "rename to src/main.txt",
            "--- a/src/app.txt",
            "+++ b/src/main.txt",
            "@@ -1 +1 @@",
            "-old",
            "+new",
            "diff --git a/obsolete.txt b/obsolete.txt",
            "deleted file mode 100644",
            "--- a/obsolete.txt",
            "+++ /dev/null",
            "diff --git a/dev/null b/notes/hello.txt",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/notes/hello.txt",
            "@@ -0,0 +1 @@",
            "+hello",
            "`)",
            "console.log(output)",
          ].join("\n"),
        })
        .pipe(
          Stream.mkString,
          Effect.provideServices(makeContextNoop(tempRoot)),
        )

      expect(output).toContain("A notes/hello.txt")
      expect(output).toContain("M src/main.txt")
      expect(output).toContain("D obsolete.txt")
      expect(
        yield* fs.readFileString(join(tempRoot, "notes", "hello.txt")),
      ).toBe("hello\n")
      expect(yield* fs.readFileString(join(tempRoot, "src", "main.txt"))).toBe(
        "new\n",
      )
      yield* Effect.flip(fs.readFileString(join(tempRoot, "obsolete.txt")))
      yield* Effect.flip(fs.readFileString(join(tempRoot, "src", "app.txt")))
    }).pipe(
      Effect.provide([
        AgentToolHandlers,
        Executor.layer,
        ToolkitRenderer.layer,
      ]),
      Effect.provide(NodeServices.layer),
    ),
  )

  it.effect("plans later hunks against in-memory file state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tempRoot = yield* makeTempRoot("clanka-apply-patch-state-")
      yield* fs.makeDirectory(join(tempRoot, "src"), { recursive: true })
      yield* fs.writeFileString(join(tempRoot, "src", "app.txt"), "old\n")

      const executor = yield* Executor
      const tools = yield* AgentTools
      const output = yield* executor
        .execute({
          tools,
          script: [
            "const output = await applyPatch(`",
            "diff --git a/dev/null b/notes/hello.txt",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/notes/hello.txt",
            "@@ -0,0 +1 @@",
            "+hello",
            "diff --git a/notes/hello.txt b/notes/hello.txt",
            "--- a/notes/hello.txt",
            "+++ b/notes/hello.txt",
            "@@ -1 +1 @@",
            "-hello",
            "+hello again",
            "diff --git a/src/app.txt b/src/main.txt",
            "similarity index 100%",
            "rename from src/app.txt",
            "rename to src/main.txt",
            "--- a/src/app.txt",
            "+++ b/src/main.txt",
            "@@ -1 +1 @@",
            "-old",
            "+new",
            "diff --git a/src/main.txt b/src/main.txt",
            "--- a/src/main.txt",
            "+++ b/src/main.txt",
            "@@ -1 +1 @@",
            "-new",
            "+newer",
            "`)",
            "console.log(output)",
          ].join("\n"),
        })
        .pipe(
          Stream.mkString,
          Effect.provideServices(makeContextNoop(tempRoot)),
        )

      expect(output).toContain("A notes/hello.txt")
      expect(output).toContain("M notes/hello.txt")
      expect(output).toContain("M src/main.txt")
      expect(
        yield* fs.readFileString(join(tempRoot, "notes", "hello.txt")),
      ).toBe("hello again\n")
      expect(yield* fs.readFileString(join(tempRoot, "src", "main.txt"))).toBe(
        "newer\n",
      )
      yield* Effect.flip(fs.readFileString(join(tempRoot, "src", "app.txt")))
    }).pipe(
      Effect.provide([
        AgentToolHandlers,
        Executor.layer,
        ToolkitRenderer.layer,
      ]),
      Effect.provide(NodeServices.layer),
    ),
  )

  it.effect("applies wrapped apply_patch patches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tempRoot = yield* makeTempRoot("clanka-apply-patch-wrapped-")
      yield* fs.makeDirectory(join(tempRoot, "src"), { recursive: true })
      yield* fs.writeFileString(join(tempRoot, "src", "app.txt"), "old\n")
      yield* fs.writeFileString(join(tempRoot, "obsolete.txt"), "remove me\n")

      const executor = yield* Executor
      const tools = yield* AgentTools
      const output = yield* executor
        .execute({
          tools,
          script: [
            "const output = await applyPatch(`",
            "*** Begin Patch",
            "*** Update File: src/app.txt",
            "*** Move to: src/main.txt",
            "@@",
            "-old",
            "+new",
            "*** Delete File: obsolete.txt",
            "*** Add File: notes/hello.txt",
            "+hello",
            "*** End Patch",
            "`)",
            "console.log(output)",
          ].join("\n"),
        })
        .pipe(
          Stream.mkString,
          Effect.provideServices(makeContextNoop(tempRoot)),
        )

      expect(output).toContain("A notes/hello.txt")
      expect(output).toContain("M src/main.txt")
      expect(output).toContain("D obsolete.txt")
      expect(
        yield* fs.readFileString(join(tempRoot, "notes", "hello.txt")),
      ).toBe("hello\n")
      expect(yield* fs.readFileString(join(tempRoot, "src", "main.txt"))).toBe(
        "new\n",
      )
      yield* Effect.flip(fs.readFileString(join(tempRoot, "obsolete.txt")))
      yield* Effect.flip(fs.readFileString(join(tempRoot, "src", "app.txt")))
    }).pipe(
      Effect.provide([
        AgentToolHandlers,
        Executor.layer,
        ToolkitRenderer.layer,
      ]),
      Effect.provide(NodeServices.layer),
    ),
  )

  it.effect(
    "applies larger wrapped apply_patch patches across multiple files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tempRoot = yield* makeTempRoot(
          "clanka-apply-patch-wrapped-large-",
        )
        yield* fs.makeDirectory(join(tempRoot, "src"), { recursive: true })
        yield* fs.makeDirectory(join(tempRoot, "docs"), { recursive: true })
        yield* fs.writeFileString(
          join(tempRoot, "src", "app.txt"),
          "alpha\nbeta\n",
        )
        yield* fs.writeFileString(
          join(tempRoot, "src", "config.json"),
          '{"enabled":false}\n',
        )
        yield* fs.writeFileString(join(tempRoot, "docs", "old.md"), "legacy\n")
        yield* fs.writeFileString(
          join(tempRoot, "README.md"),
          "# Title\nOld intro\n",
        )

        const executor = yield* Executor
        const tools = yield* AgentTools
        const output = yield* executor
          .execute({
            tools,
            script: [
              "const output = await applyPatch(`",
              "*** Begin Patch",
              "",
              "*** Update File: src/app.txt",
              "*** Move to: src/main.txt",
              "@@",
              " alpha",
              "-beta",
              "+gamma",
              "",
              "*** Update File: src/config.json",
              "@@",
              '-{"enabled":false}',
              '+{"enabled":true}',
              "",
              "*** Update File: README.md",
              "@@",
              " # Title",
              "-Old intro",
              "+New intro",
              "+More details",
              "",
              "*** Delete File: docs/old.md",
              "",
              "*** Add File: docs/new.md",
              "+# Docs",
              "+",
              "+Updated",
              "",
              "*** Add File: notes/todo.txt",
              "+one",
              "+two",
              "*** End Patch",
              "`)",
              "console.log(output)",
            ].join("\n"),
          })
          .pipe(
            Stream.mkString,
            Effect.provideServices(makeContextNoop(tempRoot)),
          )

        expect(output).toContain("M src/main.txt")
        expect(output).toContain("M src/config.json")
        expect(output).toContain("M README.md")
        expect(output).toContain("D docs/old.md")
        expect(output).toContain("A docs/new.md")
        expect(output).toContain("A notes/todo.txt")
        expect(
          yield* fs.readFileString(join(tempRoot, "src", "main.txt")),
        ).toBe("alpha\ngamma\n")
        expect(
          yield* fs.readFileString(join(tempRoot, "src", "config.json")),
        ).toBe('{"enabled":true}\n')
        expect(yield* fs.readFileString(join(tempRoot, "README.md"))).toBe(
          "# Title\nNew intro\nMore details\n",
        )
        expect(yield* fs.readFileString(join(tempRoot, "docs", "new.md"))).toBe(
          "# Docs\n\nUpdated\n",
        )
        expect(
          yield* fs.readFileString(join(tempRoot, "notes", "todo.txt")),
        ).toBe("one\ntwo\n")
        yield* Effect.flip(fs.readFileString(join(tempRoot, "docs", "old.md")))
        yield* Effect.flip(fs.readFileString(join(tempRoot, "src", "app.txt")))
      }).pipe(
        Effect.provide([
          AgentToolHandlers,
          Executor.layer,
          ToolkitRenderer.layer,
        ]),
        Effect.provide(NodeServices.layer),
      ),
  )

  it.effect(
    "chains wrapped apply_patch updates through in-memory renamed state",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tempRoot = yield* makeTempRoot(
          "clanka-apply-patch-wrapped-state-",
        )
        yield* fs.makeDirectory(join(tempRoot, "src"), { recursive: true })
        yield* fs.writeFileString(join(tempRoot, "src", "app.txt"), "old\n")

        const executor = yield* Executor
        const tools = yield* AgentTools
        const output = yield* executor
          .execute({
            tools,
            script: [
              "const output = await applyPatch(`",
              "*** Begin Patch",
              "*** Update File: src/app.txt",
              "*** Move to: src/main.txt",
              "@@",
              "-old",
              "+new",
              "*** Update File: src/main.txt",
              "@@",
              "-new",
              "+newer",
              "*** Add File: notes/hello.txt",
              "+hello",
              "*** Update File: notes/hello.txt",
              "@@",
              "-hello",
              "+hello again",
              "*** End Patch",
              "`)",
              "console.log(output)",
            ].join("\n"),
          })
          .pipe(
            Stream.mkString,
            Effect.provideServices(makeContextNoop(tempRoot)),
          )

        expect(output).toContain("M src/main.txt")
        expect(output).toContain("A notes/hello.txt")
        expect(output).toContain("M notes/hello.txt")
        expect(
          yield* fs.readFileString(join(tempRoot, "src", "main.txt")),
        ).toBe("newer\n")
        expect(
          yield* fs.readFileString(join(tempRoot, "notes", "hello.txt")),
        ).toBe("hello again\n")
        yield* Effect.flip(fs.readFileString(join(tempRoot, "src", "app.txt")))
      }).pipe(
        Effect.provide([
          AgentToolHandlers,
          Executor.layer,
          ToolkitRenderer.layer,
        ]),
        Effect.provide(NodeServices.layer),
      ),
  )

  it.effect("applies wrapped apply_patch patches with multiple hunks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tempRoot = yield* makeTempRoot("clanka-apply-patch-wrapped-hunks-")
      yield* fs.writeFileString(
        join(tempRoot, "multi.txt"),
        "line1\nline2\nline3\nline4\n",
      )

      const executor = yield* Executor
      const tools = yield* AgentTools
      const output = yield* executor
        .execute({
          tools,
          script: [
            "const output = await applyPatch(`",
            "*** Begin Patch",
            "*** Update File: multi.txt",
            "@@",
            "-line2",
            "+changed2",
            "@@",
            "-line4",
            "+changed4",
            "*** End Patch",
            "`)",
            "console.log(output)",
          ].join("\n"),
        })
        .pipe(
          Stream.mkString,
          Effect.provideServices(makeContextNoop(tempRoot)),
        )

      expect(output).toContain("M multi.txt")
      expect(yield* fs.readFileString(join(tempRoot, "multi.txt"))).toBe(
        "line1\nchanged2\nline3\nchanged4\n",
      )
    }).pipe(
      Effect.provide([
        AgentToolHandlers,
        Executor.layer,
        ToolkitRenderer.layer,
      ]),
      Effect.provide(NodeServices.layer),
    ),
  )

  it.effect(
    "applies realistic multi-file git patches with repeated multi-hunk updates",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tempRoot = yield* makeTempRoot("clanka-apply-patch-realistic-")
        yield* fs.makeDirectory(join(tempRoot, "dist", "internal"), {
          recursive: true,
        })

        const initial = [
          "if (reasoningStarted && !textStarted) {",
          "  controller.enqueue({",
          '    type: "reasoning-end",',
          "    id: reasoningId || generateId()",
          "  });",
          "}",
          "",
          "separator",
          "",
          "if (reasoningStarted) {",
          "  controller.enqueue({",
          '    type: "reasoning-end",',
          "    id: reasoningId || generateId()",
          "  });",
          "}",
          "",
        ].join("\n")

        for (const path of [
          join(tempRoot, "dist", "index.js"),
          join(tempRoot, "dist", "index.mjs"),
          join(tempRoot, "dist", "internal", "index.js"),
          join(tempRoot, "dist", "internal", "index.mjs"),
        ]) {
          yield* fs.writeFileString(path, initial)
        }

        const executor = yield* Executor
        const tools = yield* AgentTools
        const output = yield* executor
          .execute({
            tools,
            script: [
              "const output = await applyPatch(`",
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
              "@@ -10,7 +15,12 @@",
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
              "@@ -10,7 +15,12 @@",
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
              "@@ -10,7 +15,12 @@",
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
              "@@ -10,7 +15,12 @@",
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
              "`)",
              "console.log(output)",
            ].join("\n"),
          })
          .pipe(
            Stream.mkString,
            Effect.provideServices(makeContextNoop(tempRoot)),
          )

        expect(output).toContain("M dist/index.js")
        expect(output).toContain("M dist/index.mjs")
        expect(output).toContain("M dist/internal/index.js")
        expect(output).toContain("M dist/internal/index.mjs")

        const expected = [
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
          "",
          "separator",
          "",
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
          "",
        ].join("\n")

        for (const path of [
          join(tempRoot, "dist", "index.js"),
          join(tempRoot, "dist", "index.mjs"),
          join(tempRoot, "dist", "internal", "index.js"),
          join(tempRoot, "dist", "internal", "index.mjs"),
        ]) {
          expect(yield* fs.readFileString(path)).toBe(expected)
        }
      }).pipe(
        Effect.provide([
          AgentToolHandlers,
          Executor.layer,
          ToolkitRenderer.layer,
        ]),
        Effect.provide(NodeServices.layer),
      ),
  )

  it.effect("fails multi-file git patches atomically", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tempRoot = yield* makeTempRoot("clanka-apply-patch-git-fail-")
      yield* fs.makeDirectory(join(tempRoot, "src"), { recursive: true })
      yield* fs.writeFileString(join(tempRoot, "src", "app.txt"), "old\n")
      yield* fs.writeFileString(join(tempRoot, "keep.txt"), "keep\n")

      const executor = yield* Executor
      const tools = yield* AgentTools
      const output = yield* executor
        .execute({
          tools,
          script: [
            "await applyPatch(`",
            "diff --git a/src/app.txt b/src/main.txt",
            "similarity index 100%",
            "rename from src/app.txt",
            "rename to src/main.txt",
            "--- a/src/app.txt",
            "+++ b/src/main.txt",
            "@@ -1 +1 @@",
            "-missing",
            "+new",
            "diff --git a/keep.txt b/keep.txt",
            "deleted file mode 100644",
            "--- a/keep.txt",
            "+++ /dev/null",
            "diff --git a/dev/null b/notes/hello.txt",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/notes/hello.txt",
            "@@ -0,0 +1 @@",
            "+hello",
            "`)",
          ].join("\n"),
        })
        .pipe(
          Stream.mkString,
          Effect.provideServices(makeContextNoop(tempRoot)),
        )

      expect(output).toContain("applyPatch verification failed")
      expect(output).toContain("Failed to find expected lines")
      expect(yield* fs.readFileString(join(tempRoot, "src", "app.txt"))).toBe(
        "old\n",
      )
      expect(yield* fs.readFileString(join(tempRoot, "keep.txt"))).toBe(
        "keep\n",
      )
      yield* Effect.flip(fs.readFileString(join(tempRoot, "src", "main.txt")))
      yield* Effect.flip(
        fs.readFileString(join(tempRoot, "notes", "hello.txt")),
      )
    }).pipe(
      Effect.provide([
        AgentToolHandlers,
        Executor.layer,
        ToolkitRenderer.layer,
      ]),
      Effect.provide(NodeServices.layer),
    ),
  )

  it.effect("fails wrapped apply_patch patches atomically", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tempRoot = yield* makeTempRoot("clanka-apply-patch-wrapped-fail-")
      yield* fs.makeDirectory(join(tempRoot, "src"), { recursive: true })
      yield* fs.writeFileString(join(tempRoot, "src", "app.txt"), "old\n")
      yield* fs.writeFileString(join(tempRoot, "keep.txt"), "keep\n")

      const executor = yield* Executor
      const tools = yield* AgentTools
      const output = yield* executor
        .execute({
          tools,
          script: [
            "await applyPatch(`",
            "*** Begin Patch",
            "*** Update File: src/app.txt",
            "@@",
            "-missing",
            "+new",
            "*** Delete File: keep.txt",
            "*** Add File: notes/hello.txt",
            "+hello",
            "*** End Patch",
            "`)",
          ].join("\n"),
        })
        .pipe(
          Stream.mkString,
          Effect.provideServices(makeContextNoop(tempRoot)),
        )

      expect(output).toContain("applyPatch verification failed")
      expect(output).toContain("Failed to find expected lines")
      expect(yield* fs.readFileString(join(tempRoot, "src", "app.txt"))).toBe(
        "old\n",
      )
      expect(yield* fs.readFileString(join(tempRoot, "keep.txt"))).toBe(
        "keep\n",
      )
      yield* Effect.flip(
        fs.readFileString(join(tempRoot, "notes", "hello.txt")),
      )
    }).pipe(
      Effect.provide([
        AgentToolHandlers,
        Executor.layer,
        ToolkitRenderer.layer,
      ]),
      Effect.provide(NodeServices.layer),
    ),
  )

  it.effect("renames a file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tempRoot = yield* makeTempRoot("clanka-rename-file-")
      yield* fs.makeDirectory(join(tempRoot, "src"), { recursive: true })
      yield* fs.writeFileString(join(tempRoot, "src", "app.txt"), "hello\n")

      const executor = yield* Executor
      const tools = yield* AgentTools
      yield* executor
        .execute({
          tools,
          script: [
            "await renameFile({",
            '  from: "src/app.txt",',
            '  to: "src/main.txt",',
            "})",
            'console.log("renamed")',
          ].join("\n"),
        })
        .pipe(
          Stream.mkString,
          Effect.provideServices(makeContextNoop(tempRoot)),
        )

      expect(yield* fs.readFileString(join(tempRoot, "src", "main.txt"))).toBe(
        "hello\n",
      )
      yield* Effect.flip(fs.readFileString(join(tempRoot, "src", "app.txt")))
    }).pipe(
      Effect.provide([
        AgentToolHandlers,
        Executor.layer,
        ToolkitRenderer.layer,
        NodeFileSystem.layer,
      ]),
      Effect.provide(NodeServices.layer),
    ),
  )
})

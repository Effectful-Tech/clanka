import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  AgentToolHandlers,
  AgentTools,
  CurrentDirectory,
  TaskCompleteDeferred,
} from "./AgentTools.ts"
import { Executor } from "./Executor.ts"
import { ToolkitRenderer } from "./ToolkitRenderer.ts"

describe("AgentTools", () => {
  it("renders the httpGet and applyPatch tool signatures", async () => {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const renderer = yield* ToolkitRenderer
        return renderer.render(AgentTools)
      }).pipe(
        Effect.provide([
          AgentToolHandlers,
          Executor.layer,
          ToolkitRenderer.layer,
        ]),
        Effect.provideService(CurrentDirectory, process.cwd()),
        Effect.provideServiceEffect(
          TaskCompleteDeferred,
          Deferred.make<string>(),
        ),
      ),
    )

    expect(output).toContain("/** Fetch a URL and return its text response. */")
    expect(output).toContain("declare function httpGet(options: {")
    expect(output).toContain("readonly url: string;")
    expect(output).toContain("readonly headers?: {")
    expect(output).toContain("[x: string]: string;")
    expect(output).toContain("/** Apply a patch across one or more files. */")
    expect(output).toContain(
      "declare function applyPatch(patchText: /** Wrapped patch with Add/Delete/Update sections. */",
    )
    expect(output).not.toContain("declare function python(")
  })

  it("fetches text responses with httpGet headers", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "clanka-http-get-"))
    const server = createServer((request, response) => {
      const value = request.headers["x-clanka-token"]
      const token = Array.isArray(value)
        ? value.join(",")
        : (value ?? "missing")
      response.setHeader("content-type", "text/plain; charset=utf-8")
      response.end(`Header: ${token}\n`)
    })

    try {
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve())
      })

      const address = server.address()
      if (address === null || typeof address === "string") {
        throw new Error("Expected httpGet test server to listen on a TCP port")
      }

      const output = await Effect.runPromise(
        Effect.gen(function* () {
          const executor = yield* Executor
          const tools = yield* AgentTools

          return yield* executor
            .execute({
              tools,
              script: [
                "const output = await httpGet({",
                `  url: "http://127.0.0.1:${address.port}/message",`,
                '  headers: { "x-clanka-token": "secret-value" },',
                "})",
                "console.log(output.trimEnd())",
              ].join("\n"),
            })
            .pipe(Stream.mkString)
        }).pipe(
          Effect.provide([
            AgentToolHandlers,
            Executor.layer,
            ToolkitRenderer.layer,
          ]),
          Effect.provideService(CurrentDirectory, tempRoot),
          Effect.provideServiceEffect(
            TaskCompleteDeferred,
            Deferred.make<string>(),
          ),
        ),
      )

      expect(output).toContain("Header: secret-value")
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
      await rm(tempRoot, { force: true, recursive: true })
    }
  })

  it("applies multi-file patches with add, move, and delete", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "clanka-apply-patch-"))

    try {
      await mkdir(join(tempRoot, "src"), { recursive: true })
      await writeFile(join(tempRoot, "src", "app.txt"), "old\n", "utf8")
      await writeFile(join(tempRoot, "obsolete.txt"), "remove me\n", "utf8")

      const output = await Effect.runPromise(
        Effect.gen(function* () {
          const executor = yield* Executor
          const tools = yield* AgentTools

          return yield* executor
            .execute({
              tools,
              script: [
                "const output = await applyPatch(`",
                "*** Begin Patch",
                "*** Add File: notes/hello.txt",
                "+hello",
                "*** Update File: src/app.txt",
                "*** Move to: src/main.txt",
                "@@",
                "-old",
                "+new",
                "*** Delete File: obsolete.txt",
                "*** End Patch",
                "`)",
                "console.log(output)",
              ].join("\n"),
            })
            .pipe(Stream.mkString)
        }).pipe(
          Effect.provide([
            AgentToolHandlers,
            Executor.layer,
            ToolkitRenderer.layer,
          ]),
          Effect.provideService(CurrentDirectory, tempRoot),
          Effect.provideServiceEffect(
            TaskCompleteDeferred,
            Deferred.make<string>(),
          ),
        ),
      )

      expect(output).toContain("A notes/hello.txt")
      expect(output).toContain("M src/main.txt")
      expect(output).toContain("D obsolete.txt")
      expect(await readFile(join(tempRoot, "notes", "hello.txt"), "utf8")).toBe(
        "hello\n",
      )
      expect(await readFile(join(tempRoot, "src", "main.txt"), "utf8")).toBe(
        "new\n",
      )
      await expect(
        readFile(join(tempRoot, "obsolete.txt"), "utf8"),
      ).rejects.toThrow()
      await expect(
        readFile(join(tempRoot, "src", "app.txt"), "utf8"),
      ).rejects.toThrow()
    } finally {
      await rm(tempRoot, { force: true, recursive: true })
    }
  })

  it("plans later hunks against in-memory file state", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "clanka-apply-patch-state-"))

    try {
      await mkdir(join(tempRoot, "src"), { recursive: true })
      await writeFile(join(tempRoot, "src", "app.txt"), "old\n", "utf8")

      const output = await Effect.runPromise(
        Effect.gen(function* () {
          const executor = yield* Executor
          const tools = yield* AgentTools

          return yield* executor
            .execute({
              tools,
              script: [
                "const output = await applyPatch(`",
                "*** Begin Patch",
                "*** Add File: notes/hello.txt",
                "+hello",
                "*** Update File: notes/hello.txt",
                "@@",
                "-hello",
                "+hello again",
                "*** Update File: src/app.txt",
                "*** Move to: src/main.txt",
                "@@",
                "-old",
                "+new",
                "*** Update File: src/main.txt",
                "@@",
                "-new",
                "+newer",
                "*** End Patch",
                "`)",
                "console.log(output)",
              ].join("\n"),
            })
            .pipe(Stream.mkString)
        }).pipe(
          Effect.provide([
            AgentToolHandlers,
            Executor.layer,
            ToolkitRenderer.layer,
          ]),
          Effect.provideService(CurrentDirectory, tempRoot),
          Effect.provideServiceEffect(
            TaskCompleteDeferred,
            Deferred.make<string>(),
          ),
        ),
      )

      expect(output).toContain("A notes/hello.txt")
      expect(output).toContain("M notes/hello.txt")
      expect(output).toContain("M src/main.txt")
      expect(await readFile(join(tempRoot, "notes", "hello.txt"), "utf8")).toBe(
        "hello again\n",
      )
      expect(await readFile(join(tempRoot, "src", "main.txt"), "utf8")).toBe(
        "newer\n",
      )
      await expect(
        readFile(join(tempRoot, "src", "app.txt"), "utf8"),
      ).rejects.toThrow()
    } finally {
      await rm(tempRoot, { force: true, recursive: true })
    }
  })

  it("renames a file", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "clanka-rename-file-"))

    try {
      await mkdir(join(tempRoot, "src"), { recursive: true })
      await writeFile(join(tempRoot, "src", "app.txt"), "hello\n", "utf8")

      await Effect.runPromise(
        Effect.gen(function* () {
          const executor = yield* Executor
          const tools = yield* AgentTools

          return yield* executor
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
            .pipe(Stream.mkString)
        }).pipe(
          Effect.provide([
            AgentToolHandlers,
            Executor.layer,
            ToolkitRenderer.layer,
          ]),
          Effect.provideService(CurrentDirectory, tempRoot),
          Effect.provideServiceEffect(
            TaskCompleteDeferred,
            Deferred.make<string>(),
          ),
        ),
      )

      expect(await readFile(join(tempRoot, "src", "main.txt"), "utf8")).toBe(
        "hello\n",
      )
      await expect(
        readFile(join(tempRoot, "src", "app.txt"), "utf8"),
      ).rejects.toThrow()
    } finally {
      await rm(tempRoot, { force: true, recursive: true })
    }
  })
})

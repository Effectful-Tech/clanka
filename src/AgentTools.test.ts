import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
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
  it("renders the httpGet tool signature", async () => {
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
})

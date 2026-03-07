import { NodeServices } from "@effect/platform-node"
import { Deferred, Effect, Layer } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  AgentToolHandlers,
  AgentTools,
  CurrentDirectory,
  TaskCompleteDeferred,
} from "./AgentTools.ts"

const dirs = Array<string>()

const makeDir = async () => {
  const dir = await Fs.mkdtemp(Path.join(Os.tmpdir(), "clanka-agent-tools-"))
  dirs.push(dir)
  return dir
}

const call = (
  dir: string,
  name: keyof typeof AgentTools.tools,
  params: unknown,
): Promise<string> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const all = yield* Effect.services()
        const tool = AgentTools.tools[name]
        const handler = all.mapUnsafe.get(tool.id) as Tool.Handler<string>
        return (yield* handler
          .handler(params, {})
          .pipe(Effect.provideServices(handler.services))) as string
      }),
      AgentToolHandlers.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Layer.succeed(CurrentDirectory, dir)),
        Layer.provideMerge(
          Layer.effect(TaskCompleteDeferred, Deferred.make<string>()),
        ),
      ),
    ),
  )

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => Fs.rm(dir, { recursive: true, force: true })),
  )
})

describe("AgentTools", () => {
  it("includes applyPatch", () => {
    expect(AgentTools.tools).toHaveProperty("applyPatch")
  })

  it("applies patches relative to the current directory", async () => {
    const dir = await makeDir()
    const file = Path.join(dir, "sample.txt")
    await Fs.writeFile(file, "before\n", "utf8")

    const result = await call(dir, "applyPatch", {
      path: "sample.txt",
      patchText: "@@\n-before\n+after",
    })

    expect(result).toContain("M sample.txt")
    expect(await Fs.readFile(file, "utf8")).toBe("after\n")
  })

  it("reads files relative to the current directory", async () => {
    const dir = await makeDir()
    const file = Path.join(dir, "nested", "note.txt")
    await Fs.mkdir(Path.dirname(file), { recursive: true })
    await Fs.writeFile(file, "hello\nworld\n", "utf8")

    const result = await call(dir, "readFile", {
      path: "nested/note.txt",
      startLine: 2,
    })

    expect(result).toBe("world")
  })
})

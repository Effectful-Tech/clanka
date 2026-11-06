import { assert, describe, it } from "@effect/vitest"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Stream from "effect/Stream"
import * as AgentExecutor from "./AgentExecutor.ts"
import { agentTasksUnavailable } from "./AgentTools.ts"

const match = "ignored-directory-regression-match"

const withProject = <A, E, R>(f: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const project = yield* fs.makeTempDirectoryScoped()
    yield* fs.makeDirectory(path.join(project, ".git"))
    yield* fs.writeFileString(
      path.join(project, ".gitignore"),
      "node_modules/\n",
    )
    yield* fs.makeDirectory(path.join(project, "src"))
    yield* fs.makeDirectory(path.join(project, ".git", "src"))
    yield* fs.makeDirectory(path.join(project, "node_modules", "dependency"), {
      recursive: true,
    })
    yield* fs.makeDirectory(
      path.join(project, "node_modules", "dependency", "src"),
    )
    yield* fs.writeFileString(
      path.join(project, "src", "visible.ts"),
      `${match} visible`,
    )
    yield* fs.writeFileString(
      path.join(project, "node_modules", "dependency", "ignored.ts"),
      `${match} ignored`,
    )
    yield* fs.writeFileString(
      path.join(project, "node_modules", "dependency", "src", "inner.ts"),
      `${match} ignored dependency source`,
    )
    yield* fs.writeFileString(
      path.join(project, ".git", "src", "hidden.ts"),
      `${match} hidden git source`,
    )

    return yield* f.pipe(
      Effect.provide(
        AgentExecutor.layerLocal({ directory: project }).pipe(
          Layer.provide(NodeHttpClient.layerUndici),
        ),
      ),
    )
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const rg = (glob?: string) =>
  Effect.gen(function* () {
    const executor = yield* AgentExecutor.AgentExecutor
    const output = yield* executor.executeUnsafe({
      tool: "rg",
      params: { pattern: match, glob },
    })
    assert.isString(output)
    return output
  })

describe("rg", () => {
  it.effect("does not search ignored directories by default", () =>
    withProject(
      Effect.gen(function* () {
        const output = yield* rg()
        assert.include(output, "src/visible.ts")
        assert.notInclude(output, "node_modules/dependency/ignored.ts")
      }),
    ),
  )

  it.effect("does not search ignored directories for an ordinary glob", () =>
    withProject(
      Effect.gen(function* () {
        const output = yield* rg("**/*.ts")
        assert.include(output, "src/visible.ts")
        assert.notInclude(output, "node_modules/dependency/ignored.ts")
      }),
    ),
  )

  it.effect("does not search ignored paths for an ordinary scoped glob", () =>
    withProject(
      Effect.gen(function* () {
        const output = yield* rg("**/src/*.ts")
        assert.include(output, "src/visible.ts")
        assert.notInclude(output, "node_modules/dependency/src/inner.ts")
        assert.notInclude(output, ".git/src/hidden.ts")
      }),
    ),
  )

  it.effect("searches an ignored directory explicitly named in the glob", () =>
    withProject(
      Effect.gen(function* () {
        const output = yield* rg("**/node_modules/**")
        assert.include(output, "node_modules/dependency/ignored.ts")
      }),
    ),
  )

  it.effect("searches a root-relative ignored directory glob", () =>
    withProject(
      Effect.gen(function* () {
        const output = yield* rg("node_modules/**")
        assert.include(output, "node_modules/dependency/ignored.ts")
      }),
    ),
  )
})

describe("writeFile", () => {
  it.effect("writes Uint8Array content as raw bytes", () =>
    withProject(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const executor = yield* AgentExecutor.AgentExecutor
        const { environment } = yield* executor.capabilities
        yield* executor
          .execute({
            environment,
            onEnvironment: () => Effect.void,
            script:
              'await writeFile({ path: "data.bin", content: new Uint8Array([0, 255, 128]) })',
            onImage: () => Effect.void,
            onTaskComplete: () => Effect.void,
            agentTasks: agentTasksUnavailable,
          })
          .pipe(Stream.runDrain)
        const bytes = yield* fs.readFile(path.join(environment.cwd, "data.bin"))
        assert.deepStrictEqual(Array.from(bytes), [0, 255, 128])
      }),
    ),
  )
})

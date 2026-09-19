import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("../", import.meta.url))

// Run source in a fresh Node process: Vitest and other tests already import
// these dependencies. Observe the real module loader, not source text or RSS.
const probe = (body: string, setup = "") => {
  const directory = mkdtempSync(join(tmpdir(), "clanka-imports-"))
  const reportPath = join(directory, "report.json")
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
        import assert from "node:assert/strict"
        import { writeFileSync } from "node:fs"
        import { registerHooks } from "node:module"
        const loaded = []
        const requested = []
        const mocks = new Map()
        ${setup}
        registerHooks({
          resolve(specifier, context, next) {
            requested.push(specifier)
            return next(specifier, context)
          },
          load(url, context, next) {
            loaded.push(url)
            const source = mocks.get(url)
            return source === undefined
              ? next(url, context)
              : { format: "module", source, shortCircuit: true }
          }
        })
        process.once("exit", () => {
          writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ loaded, requested }))
        })
        ${body}
      `,
      ],
      { cwd: root, encoding: "utf8", timeout: 20_000 },
    )
    expect(child.error, child.stderr).toBeUndefined()
    expect(child.signal, child.stderr).toBeNull()
    expect(child.status, child.stderr).toBe(0)
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      loaded: Array<string>
      requested: Array<string>
    }
    return { ...report, stdout: child.stdout }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const mcpModules = (loaded: Array<string>) =>
  loaded.filter((url) => url.includes("/@modelcontextprotocol/sdk/"))
const photonModules = (loaded: Array<string>) =>
  loaded.filter((url) => url.includes("/@silvia-odwyer/photon-node/"))

const imageSetup = `
  const Image = await import("./src/Image.ts")
  const Effect = await import("effect/Effect")
  // A fixed 1x1 PNG, without importing TestImages (which itself loads Photon).
  const data = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==",
    "base64"
  )
`

describe("baseline imports (isolated processes)", () => {
  it("does not load the MCP SDK when importing ExaSearch", () => {
    const { loaded } = probe(`await import("./src/ExaSearch.ts")`)
    expect(mcpModules(loaded)).toEqual([])
  })

  it("does not load the MCP SDK when building an unused ExaSearch layer", () => {
    const { loaded } = probe(`
      const ExaSearch = await import("./src/ExaSearch.ts")
      const Effect = await import("effect/Effect")
      await Effect.runPromise(Effect.gen(function* () {
        const exa = yield* ExaSearch.ExaSearch
        assert.equal(typeof exa.search, "function")
      }).pipe(Effect.provide(ExaSearch.layer)))
    `)
    expect(mcpModules(loaded)).toEqual([])
  })

  it("keeps detection and prompt helpers independent of Photon", () => {
    const { loaded } = probe(`
      ${imageSetup}
      const Prompt = await import("effect/unstable/ai/Prompt")
      assert.equal(Image.mediaTypeFromPath("shot.PNG").value, "image/png")
      assert.equal(Image.mediaTypeFromBytes(data).value, "image/png")
      assert.deepEqual(Image.dimensions(data).value, { width: 1, height: 1 })
      const prompt = Prompt.fromMessages([Image.userMessage([
        { data, mediaType: "image/png", fileName: "shot.png" }
      ])])
      assert.equal(Image.hasImages(prompt), true)
      const stripped = Image.stripImages(prompt)
      assert.equal(Image.hasImages(stripped), false)
      assert.equal(stripped.content[0].content[0].text, "[image: shot.png omitted]")
      assert.equal(Effect.isEffect(Image.prepare({ data, mediaType: "image/png" })), true)
    `)
    expect(photonModules(loaded)).toEqual([])
  })

  it("imports OutputFormatter without the Effect root barrel", () => {
    const { requested } = probe(`await import("./src/OutputFormatter.ts")`)
    expect(requested.filter((specifier) => specifier === "effect")).toEqual([])
  })

  it("runs CLI --version without barrels or optional dependencies", () => {
    const { loaded, requested, stdout } = probe(`
      process.argv = [process.execPath, "clanka", "--version"]
      await import("./src/cli.ts")
    `)
    const unwanted = loaded.filter(
      (url) =>
        /\/src\/(index|SemanticSearch|CodeChunker)\.ts$/.test(url) ||
        /\/(tree-sitter(?:-[^/]+)?|sqlite-vec|@effect\/sql-sqlite-node)\//.test(
          url,
        ),
    )
    expect(stdout).toMatch(/\d+\.\d+\.\d+/)
    expect([
      ...unwanted,
      ...mcpModules(loaded),
      ...photonModules(loaded),
      ...requested.filter((specifier) => specifier === "effect"),
    ]).toEqual([])
  })

  it("decodes and resizes on first image use, then reuses Photon", () => {
    const { loaded } = probe(`
      ${imageSetup}
      const first = await Effect.runPromise(Image.prepare({ data, mediaType: "image/png" }))
      assert.deepEqual(first, { data, mediaType: "image/png" })
      const photonLoads = () => loaded.filter(url => url.includes("/@silvia-odwyer/photon-node/"))
      assert.ok(photonLoads().length > 0, "first prepare must load Photon")
      const count = photonLoads().length
      const Photon = await import("@silvia-odwyer/photon-node")
      const image = new Photon.PhotonImage(new Uint8Array(4 * 2 * 4).fill(255), 4, 2)
      const larger = image.get_bytes()
      image.free()
      const resized = await Effect.runPromise(Image.prepare({
        data: larger, mediaType: "image/png", limits: { maxDimension: 2, maxBytes: 10000 }
      }))
      assert.equal(resized.mediaType, "image/png")
      assert.deepEqual(Image.dimensions(resized.data).value, { width: 2, height: 1 })
      assert.equal(photonLoads().length, count)
    `)
    expect(photonModules(loaded).length).toBeGreaterThan(0)
  })

  it.each([false, true])(
    "preserves first search, reuse and cleanup (retry=%s)",
    (retry) => {
      // Replace only the SDK boundary. ExaSearch, McpClient and their scopes are real,
      // and no test contacts Exa or needs credentials. No SDK import primes the cache.
      const { loaded } = probe(
        `
      const ExaSearch = await import("./src/ExaSearch.ts")
      const Effect = await import("effect/Effect")
      await Effect.runPromise(Effect.gen(function* () {
        const exa = yield* ExaSearch.ExaSearch
        assert.equal(state.connects, 0)
        assert.equal(state.calls.length, 0)
        if (${retry}) {
          const failure = yield* Effect.flip(exa.search({ query: "fails" }))
          assert.equal(failure._tag, "ExaError")
          assert.equal(state.calls.length, 0)
        }
        assert.equal(yield* exa.search({ query: "first" }), "Search results")
        assert.equal(yield* exa.search({ query: "second", numResults: 5 }), "Search results")
        assert.equal(state.connects, ${retry ? 2 : 1})
        assert.deepEqual(state.calls, [
          { name: "web_search_exa", arguments: { query: "first", num_results: 3 } },
          { name: "web_search_exa", arguments: { query: "second", num_results: 5 } }
        ])
        assert.equal(state.closes, 0)
      }).pipe(Effect.provide(ExaSearch.layer)))
      assert.equal(state.closes, state.clients)
      assert.ok(state.clients > 0)
    `,
        `
      const state = globalThis.__mcpTest = {
        clients: 0, connects: 0, calls: [], closes: 0
      }
      mocks.set(import.meta.resolve("@modelcontextprotocol/sdk/client"), ${JSON.stringify(`
        export class Client {
          constructor() { globalThis.__mcpTest.clients++ }
          async connect(transport) {
            const state = globalThis.__mcpTest
            state.connects++
            if (transport.url.href !== "https://mcp.exa.ai/mcp") throw new Error("wrong endpoint")
            if (${retry} && state.connects === 1) throw new Error("temporary failure")
          }
          async callTool(options) {
            globalThis.__mcpTest.calls.push(options)
            return { content: [{ type: "text", text: "Search results" }] }
          }
          async close() { globalThis.__mcpTest.closes++ }
        }
      `)})
      mocks.set(import.meta.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"), ${JSON.stringify(`
        export class StreamableHTTPClientTransport {
          constructor(url) { this.url = url }
        }
      `)})
    `,
      )
      expect(mcpModules(loaded).length).toBeGreaterThan(0)
    },
  )
})

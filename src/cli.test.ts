import { assert, describe, it } from "@effect/vitest"
import { readFileSync } from "node:fs"

// cli.ts starts the runtime on import. Keep these as source-level wiring
// guards; Agent.test.ts and Acp.test.ts exercise the resulting turn behavior.
const source = readFileSync(new URL("./cli.ts", import.meta.url), "utf8")
const rootCommand = source.indexOf('Command.make("clanka",')
const acpCommand = source.slice(
  source.indexOf('const acp = Command.make("acp",'),
  rootCommand,
)
const interactiveCommand = source.slice(rootCommand)

describe("CLI conversation mode wiring", () => {
  it("defaults ACP to task mode so each session can opt in via AGENTS.md", () => {
    assert.match(acpCommand, /Agent\.ConversationMode\.layer\(false\)/)
    assert.notMatch(acpCommand, /Agent\.ConversationMode\.layer\(true\)/)
  })

  it("keeps interactive mode enabled only when --prompt is absent", () => {
    assert.match(
      interactiveCommand,
      /Agent\.ConversationMode\.layer\(Option\.isNone\(prompt\)\)/,
    )
  })
})

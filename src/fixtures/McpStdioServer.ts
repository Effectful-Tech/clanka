// A stdio MCP server run as a child process by the McpServers and Acp tests.
//
// - `FIXTURE_OUT`: a file the server writes `{ pid, cwd, env }` to at startup,
//   where `env` holds `FIXTURE_PARENT` and `FIXTURE_TOKEN`.
// - `FIXTURE_FAIL`: write it to stderr and exit before connecting.
// - `FIXTURE_REJECT_INIT`: answer `initialize` with an error, and keep running
//   after stdin closes, until signalled.
import * as Fs from "node:fs"
import * as Readline from "node:readline"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { makeFakeServer, text } from "./McpFakeServer.ts"

const fail = process.env["FIXTURE_FAIL"]
if (fail !== undefined) {
  process.stderr.write(`starting fixture\n${fail}\n`)
  process.exit(1)
}

const out = process.env["FIXTURE_OUT"]
if (out !== undefined) {
  Fs.writeFileSync(
    out,
    JSON.stringify({
      pid: process.pid,
      cwd: process.cwd(),
      env: {
        FIXTURE_PARENT: process.env["FIXTURE_PARENT"],
        FIXTURE_TOKEN: process.env["FIXTURE_TOKEN"],
      },
    }),
  )
}

process.stderr.write("fixture ready\n")

if (process.env["FIXTURE_REJECT_INIT"] !== undefined) {
  setInterval(() => {}, 60_000)
  Readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line)
    if (message.method === "initialize") {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: "initialize rejected" },
        })}\n`,
      )
    }
  })
} else {
  await makeFakeServer({
    tools: [
      {
        name: "pid",
        description: "Return the server's process id",
        call: () => text(String(process.pid)),
      },
    ],
  }).connect(new StdioServerTransport())
}

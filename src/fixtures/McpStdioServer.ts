// A stdio MCP server run as a child process by the McpServers and Acp tests.
//
// - `FIXTURE_OUT`: a file the server writes `{ pid, cwd, env }` to at startup,
//   where `env` holds `FIXTURE_PARENT` and `FIXTURE_TOKEN`.
// - `FIXTURE_FAIL`: write it to stderr and exit before connecting.
import * as Fs from "node:fs"
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

await makeFakeServer({
  tools: [
    {
      name: "pid",
      description: "Return the server's process id",
      call: () => text(String(process.pid)),
    },
  ],
}).connect(new StdioServerTransport())

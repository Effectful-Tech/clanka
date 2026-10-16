import { assert, describe, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Stdio from "effect/Stdio"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import * as NodeServices from "@effect/platform-node/NodeServices"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import { vi } from "vitest"

const cli = vi.hoisted(() => ({
  program: undefined as Effect.Effect<void, unknown> | undefined,
  args: [] as Array<string>,
  requests: [] as Array<HttpClientRequest.HttpClientRequest>,
}))

vi.mock("@effect/platform-node/NodeRuntime", () => ({
  runMain: (program: Effect.Effect<void, unknown>) => {
    cli.program = program
  },
}))

vi.mock("@effect/platform-node/NodeServices", async (original) => {
  const services = await original<typeof NodeServices>()
  return {
    ...services,
    layer: Layer.merge(
      services.layer,
      Stdio.layerTest({ args: Effect.sync(() => cli.args) }),
    ),
  }
})

vi.mock("@effect/platform-node/NodeHttpClient", () => ({
  layerAgentOptions: () => Layer.empty,
  layerNodeHttpNoAgent: Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        cli.requests.push(request)
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({ error: { message: "transport probe" } }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
        )
      }),
    ),
  ),
}))

vi.mock("./GlobalWebSocket.ts", () => ({
  layerWebSocketConstructor: Layer.succeed(Socket.WebSocketConstructor, () => {
    throw new Error("API-key requests must use HTTP, not a live WebSocket")
  }),
}))

describe("CLI OpenAI API-key configuration", () => {
  for (const source of [
    "flags",
    "environment",
    "environment-url",
    "search-key",
  ] as const) {
    it.effect(
      source === "search-key"
        ? "keeps Codex login when only the search OPENAI_API_KEY is set"
        : `uses ${source} without starting Codex device login`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const configHome = yield* fs.makeTempDirectoryScoped()
          cli.requests = []
          cli.args = [
            "--provider",
            "openai",
            "--model",
            "gpt-6-astra/medium",
            "--prompt",
            "hello",
            ...(source === "flags"
              ? [
                  "--api-key",
                  "test-api-key",
                  "--api-url",
                  "https://gateway.test/v1",
                ]
              : []),
          ]
          yield* Effect.promise(() => import("./cli.ts"))
          assert.isDefined(cli.program)
          yield* cli.program!.pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({
                XDG_CONFIG_HOME: configHome,
                ...(source === "environment" || source === "environment-url"
                  ? { CLANKA_OPENAI_API_KEY: "test-api-key" }
                  : {}),
                ...(source === "environment-url"
                  ? { CLANKA_OPENAI_API_URL: "https://gateway.test/v1" }
                  : {}),
                ...(source === "search-key"
                  ? { OPENAI_API_KEY: "search-api-key" }
                  : {}),
              }),
            ),
            Effect.exit,
          )
          assert.lengthOf(cli.requests, 1)
          const request = cli.requests[0]!
          assert.strictEqual(request.method, "POST")
          if (source === "search-key") {
            assert.strictEqual(
              request.url,
              "https://auth.openai.com/api/accounts/deviceauth/usercode",
            )
            assert.isUndefined(request.headers.authorization)
            return
          }
          assert.strictEqual(
            request.url,
            source === "flags" || source === "environment-url"
              ? "https://gateway.test/v1/responses"
              : "https://api.openai.com/v1/responses",
          )
          assert.strictEqual(
            request.headers.authorization,
            "Bearer test-api-key",
          )
        }).pipe(Effect.provide(NodeServices.layer)),
    )
  }
})

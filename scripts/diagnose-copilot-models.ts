// Run from the repository root: node scripts/diagnose-copilot-models.ts
// Uses an existing clanka login only. No credentials or raw errors are printed.
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import {
  GithubCopilotAuth,
  STORE_TOKEN_KEY,
  toTokenStore,
} from "../src/CopilotAuth.ts"
import { diagnoseCatalog } from "../src/CopilotModels.ts"
import { DeviceCodeHandler } from "../src/DeviceCodeHandler.ts"

const store = Layer.unwrap(
  Effect.gen(function* () {
    const path = yield* Path.Path
    const home = yield* Config.NonEmptyString("XDG_CONFIG_HOME").pipe(
      Config.orElse(() =>
        Config.NonEmptyString("HOME").pipe(
          Config.map((home) => path.join(home, ".config")),
        ),
      ),
    )
    return KeyValueStore.layerFileSystem(path.join(home, "clanka"))
  }),
).pipe(Layer.provide(NodeServices.layer))

Effect.gen(function* () {
  const token = yield* toTokenStore(yield* KeyValueStore.KeyValueStore).get(
    STORE_TOKEN_KEY,
  )
  if (Option.isNone(token) || token.value.isExpired()) {
    yield* Console.log(
      "No existing valid Copilot login. Sign in with clanka first, then rerun this diagnostic.",
    )
    return
  }
  const report = yield* diagnoseCatalog.pipe(
    Effect.provide(GithubCopilotAuth.layerClient),
  )
  yield* Console.log(JSON.stringify(report, null, 2))
}).pipe(
  Effect.provide([
    store,
    NodeHttpClient.layerNodeHttpNoAgent.pipe(
      Layer.provide(NodeHttpClient.layerAgentOptions({ keepAlive: true })),
    ),
    Layer.succeed(DeviceCodeHandler, {
      onCode: () => Effect.die("Login required"),
    }),
  ]),
  Effect.catchCause(() =>
    Console.log(
      "Diagnostic failed; raw errors and response bodies were suppressed. No report produced.",
    ),
  ),
  Effect.provide(Logger.layer([])),
  NodeRuntime.runMain,
)

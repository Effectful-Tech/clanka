#!/usr/bin/env -S node --optimize-for-size
import * as Effect from "effect/Effect"
import * as Prompt from "effect/cli/Prompt"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as GlobalWebSocket from "./GlobalWebSocket.ts"
import * as Acp from "./Acp.ts"
import * as AgentExecutor from "./AgentExecutor.ts"
import * as Agent from "./Agent.ts"
import * as Compaction from "./Compaction.ts"
import * as McpConfig from "./McpConfig.ts"
import * as McpServers from "./McpServers.ts"
import * as ModelLayer from "./ModelLayer.ts"
import * as ModelsRepo from "./ModelsRepo.ts"
import * as Stream from "effect/Stream"
import * as Stdio from "effect/Stdio"
import { pipe } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Config from "effect/Config"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Option from "effect/Option"
import { OpenAiClient, OpenAiEmbeddingModel } from "@effect/ai-openai"
import * as DeviceCodeHandler from "./DeviceCodeHandler.ts"
import packageJson from "../package.json" with { type: "json" }

const version = packageJson.version

// node:http instead of undici: the undici package adds ~15 MB of RSS on top of
// the HTTP stack Node loads anyway, and unlike fetch it imposes no request
// timeouts on long model calls.
const HttpClientLive = NodeHttpClient.layerNodeHttpNoAgent.pipe(
  Layer.provide(NodeHttpClient.layerAgentOptions({ keepAlive: true })),
)

type Provider = ModelsRepo.Provider

const providers = ModelsRepo.Provider.literals

// Pick a model from the catalog, filtering by name as the user types, then
// one of its reasoning efforts.
const selectModel = Effect.fnUntraced(function* (provider: Provider) {
  const repo = yield* ModelsRepo.ModelsRepo
  const catalog = (yield* repo.models).filter(
    (model) => model.provider === provider,
  )
  const models =
    catalog.length > 0
      ? catalog
      : ModelsRepo.fallback.filter((model) => model.provider === provider)
  const defaultId = ModelsRepo.fallback.find(
    (model) => model.provider === provider,
  )?.id
  const model = yield* Prompt.AutoComplete({
    message: "Select a model",
    choices: models.map((model) => ({
      title: model.name,
      description: model.id,
      value: model,
      selected: model.id === defaultId,
    })),
  })
  if (model.efforts.length === 0) {
    return { model: model.id, effort: null }
  }
  const effort = yield* Prompt.Select({
    message: "Select a reasoning effort",
    choices: model.efforts.map((effort) => ({
      title: effort,
      value: effort,
      selected: effort === "medium",
    })),
  })
  return { model: model.id, effort }
})

const isProvider = Schema.is(ModelsRepo.Provider)

// `<provider>/<model>/<effort>` as accepted by the `acp` --model flag.
const parseModelId = (modelId: string) => {
  const [provider, model, effort, ...rest] = modelId.split("/")
  return isProvider(provider) &&
    model !== undefined &&
    Schema.is(Acp.ThoughtLevel)(effort) &&
    rest.length === 0
    ? Option.some({ model: `${provider}:${model}`, thoughtLevel: effort })
    : Option.none()
}

const ModelId = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (modelId: string) =>
        Option.isSome(parseModelId(modelId)) ||
        `Invalid model "${modelId}", expected <provider>/<model>/<effort> with effort one of ${Acp.ThoughtLevel.literals.join(", ")}`,
    ),
  ),
)

const provider = Flag.Literals("provider", providers).pipe(
  Flag.withAlias("p"),
  Flag.withFallbackPrompt(
    Prompt.Select({
      message: "Select a provider",
      choices: [
        {
          title: "openai",
          value: "openai",
          selected: true,
        },
        {
          title: "copilot",
          value: "copilot",
        },
        {
          title: "xai",
          value: "xai",
        },
      ],
    }),
  ),
)

const model = Flag.String("model").pipe(Flag.withAlias("m"), Flag.optional)

const apiKey = Flag.Redacted("api-key").pipe(
  Flag.withDescription("OpenAI API key (defaults to CLANKA_OPENAI_API_KEY)"),
  Flag.withFallbackConfig(Config.Redacted("CLANKA_OPENAI_API_KEY")),
  Flag.optional,
)

const apiUrl = Flag.String("api-url").pipe(
  Flag.withDescription(
    "OpenAI API base URL for API-key mode (defaults to CLANKA_OPENAI_API_URL or https://api.openai.com/v1)",
  ),
  Flag.withFallbackConfig(Config.String("CLANKA_OPENAI_API_URL")),
  Flag.optional,
)

const semantic = Flag.Directory("search").pipe(
  Flag.withDescription(
    "Directory for semantic search data (uses OPENAI_API_KEY env var)",
  ),
  Flag.withAlias("s"),
  Flag.optional,
)

const prompt = Flag.String("prompt").pipe(
  Flag.withDescription("Pass a prompt in non-interactive mode"),
  Flag.optional,
)

// Kill switch: `--no-compaction` or CLANKA_COMPACTION=false.
const compaction = Flag.Boolean("compaction").pipe(
  Flag.withDescription(
    "Auto-compact the conversation history when it nears the context window. Disable with --no-compaction or CLANKA_COMPACTION=false; the execute output cap stays on.",
  ),
  Flag.withFallbackConfig(
    Config.Boolean("CLANKA_COMPACTION").pipe(Config.withDefault(true)),
  ),
)

// Kill switch: `--no-mcp` or CLANKA_MCP=false.
const mcp = Flag.Boolean("mcp").pipe(
  Flag.withDescription(
    "Start the MCP servers from ~/.config/clanka/mcp.json, ./.mcp.json and --mcp-config. Disable with --no-mcp or CLANKA_MCP=false.",
  ),
  Flag.withFallbackConfig(
    Config.Boolean("CLANKA_MCP").pipe(Config.withDefault(true)),
  ),
)

const mcpConfig = Flag.String("mcp-config").pipe(
  Flag.withDescription(
    'An MCP config file in the { "mcpServers": { ... } } format. Repeatable; a later file wins.',
  ),
  Flag.atLeast(0),
)

// One line after connecting, such as `MCP: github (26 tools), linear failed: ...`.
const mcpSummary = (
  status: Readonly<Record<string, McpServers.ServerStatus>>,
) =>
  `MCP: ${Object.entries(status)
    .map(([name, server]) =>
      server._tag === "Connected"
        ? `${name} (${server.tools.length} tools)`
        : `${name} failed: ${server.error.split("\n")[0]}`,
    )
    .join(", ")}`

const Kvs = Layer.unwrap(
  Effect.gen(function* () {
    const path = yield* Path.Path

    const configHome = yield* Config.NonEmptyString("XDG_CONFIG_HOME").pipe(
      Config.orElse(() =>
        Config.NonEmptyString("HOME").pipe(
          Config.map((home) => path.join(home, ".config")),
        ),
      ),
    )
    return KeyValueStore.layerFileSystem(path.join(configHome, "clanka"))
  }),
).pipe(Layer.provide(NodeServices.layer))

const Search = (directory: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const apiKey = yield* Config.Redacted("OPENAI_API_KEY").pipe(
        Config.option,
      )

      if (Option.isNone(apiKey)) {
        yield* Effect.logWarning("OPENAI_API_KEY is not set")
        return Layer.empty
      }

      const path = yield* Path.Path

      const SemanticSearch = yield* Effect.promise(
        () => import("./SemanticSearch.ts"),
      )

      return SemanticSearch.layer({
        directory: process.cwd(),
        database: path.join(directory, "search.sqlite"),
      }).pipe(
        Layer.provide(
          OpenAiEmbeddingModel.model("text-embedding-3-small", {
            dimensions: 1536,
          }),
        ),
        Layer.provide(
          OpenAiClient.layer({
            apiKey: apiKey.value,
          }),
        ),
      )
    }),
  ).pipe(Layer.provide([NodeServices.layer, HttpClientLive]))

const acpModel = Flag.String("model").pipe(
  Flag.withAlias("m"),
  Flag.withDescription(
    "Default model as <provider>/<model>/<effort>, e.g. openai/gpt-6-astra/medium",
  ),
  Flag.withSchema(ModelId),
  Flag.withDefault("openai/gpt-6-astra/medium"),
  Flag.map((modelId) => Option.getOrThrow(parseModelId(modelId))),
)

const acp = Command.make("acp", {
  model: acpModel,
  compaction,
  apiKey,
  apiUrl,
}).pipe(
  Command.withDescription(
    "Run as an Agent Client Protocol (ACP) server over stdio",
  ),
  Command.withHandler(({ model, apiKey, apiUrl }) =>
    Effect.gen(function* () {
      const repo = yield* ModelsRepo.ModelsRepo
      return yield* Acp.runStdio({
        version,
        defaultModel: model.model,
        defaultThoughtLevel: model.thoughtLevel,
        availableModels: Effect.map(repo.models, ModelLayer.acpModels),
        makeAgent: (cwd) =>
          Agent.make.pipe(
            Effect.provide(AgentExecutor.layerLocal({ directory: cwd })),
          ),
        makeModel: ModelLayer.makeAcp({
          models: repo.models,
          openai: {
            apiKey: Option.getOrUndefined(apiKey),
            apiUrl: Option.getOrUndefined(apiUrl),
          },
        }),
      })
    }),
  ),
  Command.provide(({ compaction }) =>
    Layer.mergeAll(
      Agent.ConversationMode.layer(false),
      Layer.succeed(Logger.LogToStderr, true),
      DeviceCodeHandler.layerLog,
      Compaction.CompactionConfig.layer({ enabled: compaction }),
    ),
  ),
)

Command.make("clanka", {
  provider,
  model,
  semantic,
  prompt,
  compaction,
  apiKey,
  apiUrl,
  mcp,
  mcpConfig,
}).pipe(
  Command.withHandler(
    Effect.fnUntraced(function* ({
      provider,
      model: modelRaw,
      semantic,
      prompt: nonInteractivePrompt,
      apiKey,
      apiUrl,
      mcp,
      mcpConfig,
    }) {
      const stdio = yield* Stdio.Stdio
      const mcpServers = yield* McpConfig.load({
        cwd: process.cwd(),
        files: mcpConfig,
        enabled: mcp,
      })
      const OutputFormatter = yield* Effect.promise(
        () => import("./OutputFormatter.ts"),
      )
      const { model, effort } = yield* Option.match(modelRaw, {
        onSome: (selected) => {
          const [model, effort] = selected.split("/") as [
            string,
            string | undefined,
          ]
          return Effect.succeed({ model, effort })
        },
        onNone: () => selectModel(provider),
      })
      const Model = ModelLayer.make(provider, model, effort, {
        apiKey: Option.getOrUndefined(apiKey),
        apiUrl: Option.getOrUndefined(apiUrl),
      })

      return yield* Effect.gen(function* () {
        const agent = yield* Agent.Agent

        if (Option.isSome(nonInteractivePrompt)) {
          return yield* pipe(
            agent.send({ prompt: nonInteractivePrompt.value }),
            Stream.unwrap,
            OutputFormatter.pretty(),
            Stream.run(stdio.stdout()),
          )
        }

        if (Object.keys(mcpServers).length > 0) {
          const servers = yield* McpServers.McpServers
          console.log(mcpSummary(yield* servers.status))
        }

        while (true) {
          const prompt = yield* Prompt.String({
            message: ">",
          })

          yield* pipe(
            agent.send({ prompt }),
            Stream.unwrap,
            OutputFormatter.pretty({ outputTruncation: 20 }),
            Stream.run(stdio.stdout()),
          )

          console.log("")
        }
      }).pipe(
        Effect.provide([
          Agent.layerLocal({
            directory: process.cwd(),
          }).pipe(
            Layer.provide(
              Option.match(semantic, {
                onNone: () => Layer.empty,
                onSome: Search,
              }),
            ),
            Layer.provideMerge(McpServers.layer(mcpServers)),
          ),
          Model,
        ]),
      )
    }),
  ),
  Command.provide(({ prompt, compaction }) =>
    Layer.mergeAll(
      Agent.ConversationMode.layer(Option.isNone(prompt)),
      Compaction.CompactionConfig.layer({ enabled: compaction }),
    ),
  ),
  Command.withSubcommands([acp]),
  Command.run({
    version,
  }),
  Effect.provide([
    NodeServices.layer,
    ModelsRepo.ModelsRepo.layerModelsDev().pipe(
      Layer.provideMerge([Kvs, HttpClientLive]),
    ),
    GlobalWebSocket.layerWebSocketConstructor,
    DeviceCodeHandler.layerConsole,
  ]),
  NodeRuntime.runMain,
)

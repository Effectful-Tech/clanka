#!/usr/bin/env -S node --optimize-for-size
import * as Effect from "effect/Effect"
import * as Prompt from "effect/cli/Prompt"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import * as GlobalFlag from "effect/cli/GlobalFlag"
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
import { CopilotModels, CopilotModelsError } from "./CopilotModels.ts"
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

// `--reported-version` replaces the version clanka reports, for `--version`
// and to ACP clients, so it can pass the version gates of kiro launchers such
// as Multica. The built-in `--version` prints the version given to
// `Command.run`, so the value is read from argv before the CLI parses it.
const ReportedVersion = GlobalFlag.Setting("reported-version")({
  flag: Flag.String("reported-version").pipe(
    Flag.withDescription(
      "Report this version instead of clanka's own, for --version and to ACP clients",
    ),
    Flag.optional,
  ),
})

const reportedVersion = (args: ReadonlyArray<string>) => {
  for (const [index, arg] of args.entries()) {
    if (arg === "--") return undefined
    if (arg === "--reported-version") return args[index + 1]
    if (arg.startsWith("--reported-version=")) {
      return arg.slice("--reported-version=".length)
    }
  }
  return undefined
}

const version = reportedVersion(process.argv.slice(2)) ?? packageJson.version

// node:http instead of undici: the undici package adds ~15 MB of RSS on top of
// the HTTP stack Node loads anyway, and unlike fetch it imposes no request
// timeouts on long model calls.
const HttpClientLive = NodeHttpClient.layerNodeHttpNoAgent.pipe(
  Layer.provide(NodeHttpClient.layerAgentOptions({ keepAlive: true })),
)

type Provider = ModelsRepo.Provider

const providers = ModelsRepo.Provider.literals

const copilotModels = CopilotModels.use((repo) => repo.models).pipe(
  Effect.provide(CopilotModels.layerAuthenticated),
)

// Pick a model from the catalog, filtering by name as the user types, then
// one of its reasoning efforts.
const selectModel = Effect.fnUntraced(function* (provider: Provider) {
  const repo = yield* ModelsRepo.ModelsRepo
  const catalog = (
    provider === "copilot" ? yield* copilotModels : yield* repo.models
  ).filter((model) => model.provider === provider)
  if (provider === "copilot" && catalog.length === 0) {
    return yield* new CopilotModelsError({
      message:
        "Copilot advertises no supported tool-calling models for this account",
    })
  }
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

const isThoughtLevel = Schema.is(Acp.ThoughtLevel)

// `<provider>/<model>[/<effort>]` as accepted by the `acp` --model flag.
const parseModelId = (modelId: string) => {
  const [provider, model, effort, ...rest] = modelId.split("/")
  return isProvider(provider) &&
    model !== undefined &&
    (effort === undefined || isThoughtLevel(effort)) &&
    rest.length === 0
    ? Option.some({
        model: `${provider}:${model}`,
        thoughtLevel: Option.fromUndefinedOr(effort),
      })
    : Option.none()
}

const ModelId = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (modelId: string) =>
        Option.isSome(parseModelId(modelId)) ||
        `Invalid model "${modelId}", expected <provider>/<model>[/<effort>] with effort one of ${Acp.ThoughtLevel.literals.join(", ")}`,
    ),
  ),
)

// An `--subagent-model` or `--summarizer-model` value. Without an effort, the
// provider's default effort is used.
const auxiliaryModel = (options: {
  readonly name: string
  readonly env: string
  readonly description: string
}) =>
  Flag.String(options.name).pipe(
    Flag.withDescription(
      `${options.description} As <provider>/<model>[/<effort>], e.g. openai/gpt-6-astra/low; also ${options.env}.`,
    ),
    Flag.withFallbackConfig(Config.String(options.env)),
    Flag.withSchema(ModelId),
    Flag.map((modelId): ModelLayer.ModelSpec => {
      const [provider, model, effort] = modelId.split("/") as [
        Provider,
        string,
        string | undefined,
      ]
      return { provider, model, effort }
    }),
    Flag.optional,
  )

const subagentModel = auxiliaryModel({
  name: "subagent-model",
  env: "CLANKA_SUBAGENT_MODEL",
  description: "Run sub-agents on this model instead of the agent's model.",
})

const summarizerModel = auxiliaryModel({
  name: "summarizer-model",
  env: "CLANKA_SUMMARIZER_MODEL",
  description:
    "Summarize the history for compaction with this model instead of the agent's model.",
})

const auxiliaryModels = (flags: {
  readonly subagentModel: Option.Option<ModelLayer.ModelSpec>
  readonly summarizerModel: Option.Option<ModelLayer.ModelSpec>
}): ModelLayer.AuxiliaryModels => ({
  subagent: Option.getOrUndefined(flags.subagentModel),
  summarizer: Option.getOrUndefined(flags.summarizerModel),
})

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
        {
          title: "claude",
          value: "claude",
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

// OpenAI's `priority` service tier.
const fast = Flag.Boolean("fast").pipe(
  Flag.withDescription(
    "Use OpenAI fast mode (the priority service tier) for faster responses at a higher cost. Applies to the openai provider only; also CLANKA_FAST=true.",
  ),
  Flag.withFallbackConfig(
    Config.Boolean("CLANKA_FAST").pipe(Config.withDefault(false)),
  ),
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

const NonNegativeInt = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
)

// A compaction token setting, defaulting to `Compaction.defaultConfig`.
const tokens = (options: {
  readonly name: string
  readonly env: string
  readonly description: string
  readonly defaultValue: number
}) =>
  Flag.Int(options.name).pipe(
    Flag.withDescription(
      `${options.description} Defaults to ${options.env} or ${options.defaultValue}.`,
    ),
    Flag.withFallbackConfig(
      Config.Int(options.env).pipe(Config.withDefault(options.defaultValue)),
    ),
    Flag.withSchema(NonNegativeInt),
  )

const compactionThreshold = tokens({
  name: "compaction-threshold",
  env: "CLANKA_COMPACTION_THRESHOLD",
  description:
    "Compact once the context exceeds this many tokens, or the context window minus its reserve when that is lower.",
  defaultValue: Compaction.defaultConfig.thresholdTokens,
})

const compactionConfig = (flags: {
  readonly compaction: boolean
  readonly compactionThreshold: number
}) =>
  Compaction.CompactionConfig.layer({
    enabled: flags.compaction,
    thresholdTokens: flags.compactionThreshold,
  })

const fetch = Flag.Boolean("fetch").pipe(
  Flag.withDescription(
    "Expose the global Fetch API to scripts. Disable with --no-fetch or CLANKA_FETCH=false.",
  ),
  Flag.withFallbackConfig(
    Config.Boolean("CLANKA_FETCH").pipe(Config.withDefault(true)),
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
    "Default model as <provider>/<model>[/<effort>], e.g. openai/gpt-6-astra/medium. Without an effort, uses CLANKA_REASONING, or medium.",
  ),
  Flag.withSchema(ModelId),
  Flag.withDefault("openai/gpt-6-astra"),
  Flag.map((modelId) => Option.getOrThrow(parseModelId(modelId))),
)

// kiro launchers pass it to every `acp` run; clanka has no tool permissions to
// skip.
const trustAllTools = Flag.Boolean("trust-all-tools").pipe(
  Flag.withDescription(
    "Accepted for kiro-cli compatibility. Has no effect: clanka runs every tool call without asking.",
  ),
  Flag.withDefault(false),
)

// The effort for an `acp` --model without one. Read even when --model has an
// effort, so an invalid value always fails startup.
const reasoning = Config.schema(Acp.ThoughtLevel, "CLANKA_REASONING").pipe(
  Config.withDefault("medium"),
)

const acp = Command.make("acp", {
  model: acpModel,
  fetch,
  trustAllTools,
  fast,
  compaction,
  compactionThreshold,
  subagentModel,
  summarizerModel,
  apiKey,
  apiUrl,
}).pipe(
  Command.withDescription(
    "Run as an Agent Client Protocol (ACP) server over stdio",
  ),
  Command.withHandler(({ model, fast, apiKey, apiUrl, ...flags }) =>
    Effect.gen(function* () {
      const repo = yield* ModelsRepo.ModelsRepo
      const defaultThoughtLevel = yield* reasoning
      const copilot = yield* CopilotModels.pipe(
        Effect.provide(CopilotModels.layerAuthenticated),
      )
      // Never advertise models.dev aliases as Copilot API IDs. Only load
      // Copilot's account catalog when it is the configured provider, so other
      // providers do not trigger a GitHub login during ACP discovery.
      const models = yield* Effect.cached(
        Effect.gen(function* () {
          const catalog = (yield* repo.models).filter(
            (entry) => entry.provider !== "copilot",
          )
          return Option.exists(
            ModelLayer.parseAcpModelId(model.model),
            ({ provider }) => provider === "copilot",
          )
            ? [...catalog, ...(yield* copilot.models)]
            : catalog
        }).pipe(Effect.orDie),
      )
      return yield* Acp.runStdio({
        version,
        defaultModel: model.model,
        defaultThoughtLevel: Option.getOrElse(
          model.thoughtLevel,
          () => defaultThoughtLevel,
        ),
        defaultFastMode: fast,
        supportsFastMode: ModelLayer.acpSupportsFastMode,
        availableModels: Effect.map(models, ModelLayer.acpModels),
        // Built in the session scope: the executor runs commands in its own
        // scope, which `Effect.provide` would close once the agent is made.
        makeAgent: (cwd) =>
          Layer.build(
            AgentExecutor.layerLocal({
              directory: cwd,
              excludeTools: flags.fetch ? [] : ["fetch"],
            }),
          ).pipe(
            Effect.flatMap((context) =>
              Agent.make.pipe(Effect.provideContext(context)),
            ),
          ),
        makeModel: ModelLayer.makeAcp({
          models,
          openai: {
            apiKey: Option.getOrUndefined(apiKey),
            apiUrl: Option.getOrUndefined(apiUrl),
          },
          auxiliary: auxiliaryModels(flags),
        }),
      })
    }),
  ),
  Command.provide((flags) =>
    Layer.mergeAll(
      Agent.ConversationMode.layer(false),
      Layer.succeed(Logger.LogToStderr, true),
      DeviceCodeHandler.layerLog,
      compactionConfig(flags),
    ),
  ),
)

Command.make("clanka", {
  provider,
  fetch,
  model,
  fast,
  semantic,
  prompt,
  compaction,
  compactionThreshold,
  subagentModel,
  summarizerModel,
  apiKey,
  apiUrl,
  mcp,
  mcpConfig,
}).pipe(
  Command.withHandler(
    Effect.fnUntraced(function* ({
      provider,
      model: modelRaw,
      fast,
      semantic,
      prompt: nonInteractivePrompt,
      apiKey,
      apiUrl,
      mcp,
      mcpConfig,
      ...flags
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
      const Model = ModelLayer.make(
        provider,
        model,
        effort,
        {
          apiKey: Option.getOrUndefined(apiKey),
          apiUrl: Option.getOrUndefined(apiUrl),
        },
        fast,
        auxiliaryModels(flags),
      )

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
            excludeTools: flags.fetch ? [] : ["fetch"],
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
  Command.provide(({ prompt, ...flags }) =>
    Layer.mergeAll(
      Agent.ConversationMode.layer(Option.isNone(prompt)),
      compactionConfig(flags),
    ),
  ),
  Command.withSubcommands([acp]),
  Command.withGlobalFlags([ReportedVersion]),
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

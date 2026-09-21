#!/usr/bin/env -S node --optimize-for-size
import * as Effect from "effect/Effect"
import * as Prompt from "effect/unstable/cli/Prompt"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as GlobalWebSocket from "./GlobalWebSocket.ts"
import * as Acp from "./Acp.ts"
import * as AgentExecutor from "./AgentExecutor.ts"
import * as Codex from "./Codex.ts"
import * as Copilot from "./Copilot.ts"
import * as Xai from "./Xai.ts"
import * as Agent from "./Agent.ts"
import * as Compaction from "./Compaction.ts"
import * as Stream from "effect/Stream"
import * as Stdio from "effect/Stdio"
import { pipe } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import type * as LanguageModel from "effect/unstable/ai/LanguageModel"
import type * as Model from "effect/unstable/ai/Model"
import * as Config from "effect/Config"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
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

type Provider = "openai" | "copilot" | "xai"

const providers: ReadonlyArray<Provider> = ["openai", "copilot", "xai"]

const withSubagentModel = <E, R>(
  model: Layer.Layer<
    LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName,
    E,
    R
  >,
) => Layer.merge(model, Agent.layerSubagentModel(model))

const modelLayer = (provider: Provider, model: string, effort: string) =>
  provider === "openai"
    ? withSubagentModel(
        Codex.modelWebSocket(model, { reasoning: { effort: effort as any } }),
      ).pipe(Layer.provide(Codex.layerClient))
    : provider === "xai"
      ? withSubagentModel(
          Xai.model(model, { reasoning: { effort: effort as any } }),
        ).pipe(Layer.provide(Xai.layerClient))
      : withSubagentModel(Copilot.model(model, { reasoning: { effort } })).pipe(
          Layer.provide(Copilot.layerClient),
        )

const isProvider = (provider: string | undefined): provider is Provider =>
  providers.includes(provider as Provider)

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

// `<provider>:<model>` as advertised over ACP.
const parseAcpModelId = (modelId: string) => {
  const [provider, model, ...rest] = modelId.split(":")
  return isProvider(provider) && model !== undefined && rest.length === 0
    ? Option.some({ provider, model })
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

const acp = Command.make("acp", { model: acpModel, compaction }).pipe(
  Command.withDescription(
    "Run as an Agent Client Protocol (ACP) server over stdio",
  ),
  Command.withHandler(({ model }) =>
    Acp.runStdio({
      version,
      defaultModel: model.model,
      defaultThoughtLevel: model.thoughtLevel,
      makeAgent: (cwd) =>
        Agent.make.pipe(
          Effect.provide(AgentExecutor.layerLocal({ directory: cwd })),
        ),
      makeModel: (modelId, thoughtLevel) =>
        Option.map(parseAcpModelId(modelId), ({ provider, model }) =>
          modelLayer(provider, model, thoughtLevel),
        ),
    }),
  ),
  Command.provide(({ compaction }) =>
    Layer.mergeAll(
      Agent.ConversationMode.layer(true),
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
}).pipe(
  Command.withHandler(
    Effect.fnUntraced(function* ({
      provider,
      model: modelRaw,
      semantic,
      prompt: nonInteractivePrompt,
    }) {
      const stdio = yield* Stdio.Stdio
      const OutputFormatter = yield* Effect.promise(
        () => import("./OutputFormatter.ts"),
      )
      const selectedModel = yield* Option.match(modelRaw, {
        onSome: Effect.succeed,
        onNone: () =>
          Prompt.String({
            message: "Enter a model",
            default:
              provider === "xai" ? "grok-4.6/high" : "gpt-6-astra/medium",
            validate(value) {
              return value.split("/").length === 2
                ? Effect.succeed(value)
                : Effect.fail("Invalid model")
            },
          }),
      })
      const [model, reasoning] = selectedModel.split("/") as [string, string]
      const Model = modelLayer(provider, model, reasoning)

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
    Kvs,
    HttpClientLive,
    GlobalWebSocket.layerWebSocketConstructor,
    DeviceCodeHandler.layerConsole,
  ]),
  NodeRuntime.runMain,
)

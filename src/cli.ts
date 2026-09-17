#!/usr/bin/env node
import * as Effect from "effect/Effect"
import * as Prompt from "effect/unstable/cli/Prompt"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as Acp from "./Acp.ts"
import * as AgentExecutor from "./AgentExecutor.ts"
import * as Codex from "./Codex.ts"
import * as Copilot from "./Copilot.ts"
import * as Agent from "./Agent.ts"
import * as Stream from "effect/Stream"
import * as OutputFormatter from "./OutputFormatter.ts"
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
import { DeviceCodeHandler } from "./index.ts"

const version = "1.0.0"

type Provider = "openai" | "copilot"

const providers: ReadonlyArray<Provider> = ["openai", "copilot"]

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
    : withSubagentModel(Copilot.model(model, { reasoning: { effort } })).pipe(
        Layer.provide(Copilot.layerClient),
      )

const parseModelId = (modelId: string) => {
  const [provider, model, effort, ...rest] = modelId.split("/")
  return provider !== undefined &&
    providers.includes(provider as Provider) &&
    model !== undefined &&
    effort !== undefined &&
    rest.length === 0
    ? Option.some({ provider: provider as Provider, model, effort })
    : Option.none()
}

const ModelId = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (modelId: string) =>
        Option.isSome(parseModelId(modelId)) ||
        `Invalid model "${modelId}", expected <provider>/<model>/<effort>`,
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
      ],
    }),
  ),
)

const model = Flag.String("model").pipe(
  Flag.withAlias("m"),
  Flag.withFallbackPrompt(
    Prompt.String({
      message: "Enter a model",
      default: "gpt-6-astra/medium",
      validate(value) {
        const parts = value.split("/")
        if (parts.length !== 2) {
          return Effect.fail("Invalid model")
        }
        return Effect.succeed(value)
      },
    }),
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
  ).pipe(Layer.provide([NodeServices.layer, NodeHttpClient.layerUndici]))

const acpModel = Flag.String("model").pipe(
  Flag.withAlias("m"),
  Flag.withDescription(
    "Default model as <provider>/<model>/<effort>, e.g. openai/gpt-6-astra/medium",
  ),
  Flag.withSchema(ModelId),
  Flag.withDefault("openai/gpt-6-astra/medium"),
)

const acp = Command.make("acp", { model: acpModel }).pipe(
  Command.withDescription(
    "Run as an Agent Client Protocol (ACP) server over stdio",
  ),
  Command.withHandler(({ model }) =>
    Acp.runStdio({
      version,
      defaultModel: model,
      makeAgent: (cwd) =>
        Agent.make.pipe(
          Effect.provide(AgentExecutor.layerLocal({ directory: cwd })),
        ),
      makeModel: (modelId) =>
        Option.map(parseModelId(modelId), ({ provider, model, effort }) =>
          modelLayer(provider, model, effort),
        ),
    }),
  ),
  Command.provide(
    Layer.mergeAll(
      Agent.ConversationMode.layer(true),
      Layer.succeed(Logger.LogToStderr, true),
      DeviceCodeHandler.layerLog,
    ),
  ),
)

Command.make("clanka", { provider, model, semantic, prompt }).pipe(
  Command.withHandler(
    Effect.fnUntraced(function* ({
      provider,
      model: modelRaw,
      semantic,
      prompt: nonInteractivePrompt,
    }) {
      const stdio = yield* Stdio.Stdio
      const [model, reasoning] = modelRaw.split("/") as [string, string]
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
  Command.provide(({ prompt }) =>
    Agent.ConversationMode.layer(Option.isNone(prompt)),
  ),
  Command.withSubcommands([acp]),
  Command.run({
    version,
  }),
  Effect.provide([
    NodeServices.layer,
    Kvs,
    NodeHttpClient.layerUndici,
    NodeSocket.layerWebSocketConstructorWS,
    DeviceCodeHandler.layerConsole,
  ]),
  NodeRuntime.runMain,
)

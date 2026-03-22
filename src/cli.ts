#!/usr/bin/env node
import * as Effect from "effect/Effect"
import * as Prompt from "effect/unstable/cli/Prompt"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as Codex from "./Codex.ts"
import * as Copilot from "./Copilot.ts"
import * as Agent from "./Agent.ts"
import * as Stream from "effect/Stream"
import * as OutputFormatter from "./OutputFormatter.ts"
import * as Stdio from "effect/Stdio"
import { pipe } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Config from "effect/Config"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import * as Option from "effect/Option"
import { OpenAiClient, OpenAiEmbeddingModel } from "@effect/ai-openai"

const provider = Flag.choice("provider", ["openai", "copilot"]).pipe(
  Flag.withAlias("p"),
  Flag.withFallbackPrompt(
    Prompt.select({
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

const model = Flag.string("model").pipe(
  Flag.withAlias("m"),
  Flag.withFallbackPrompt(
    Prompt.text({
      message: "Enter a model",
      default: "gpt-5.4/medium",
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

const semantic = Flag.directory("search").pipe(
  Flag.withDescription(
    "Directory for semantic search data (uses OPENAI_API_KEY env var)",
  ),
  Flag.withAlias("s"),
  Flag.optional,
)

const prompt = Flag.string("prompt").pipe(
  Flag.withDescription("Pass a prompt in non-interactive mode"),
  Flag.optional,
)

const Kvs = Layer.unwrap(
  Effect.gen(function* () {
    const path = yield* Path.Path

    const configHome = yield* Config.nonEmptyString("XDG_CONFIG_HOME").pipe(
      Config.orElse(() =>
        Config.nonEmptyString("HOME").pipe(
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
      const apiKey = yield* Config.redacted("OPENAI_API_KEY").pipe(
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
      const Model =
        provider === "openai"
          ? Codex.modelWebSocket(model, {
              reasoning: {
                effort: reasoning as any,
              },
            }).pipe(
              Layer.merge(
                Agent.layerSubagentModel(
                  Codex.modelWebSocket("gpt-5.4-mini", {
                    reasoning: {
                      effort: "high",
                    },
                  }),
                ),
              ),
              Layer.provide(Codex.layerClient),
            )
          : Copilot.model(model, {
              reasoning: {
                effort: reasoning,
              },
            }).pipe(
              Layer.merge(
                Agent.layerSubagentModel(
                  Copilot.model(model, {
                    reasoning: {
                      effort: "medium",
                    },
                  }),
                ),
              ),
              Layer.provide(Copilot.layerClient),
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

        while (true) {
          const prompt = yield* Prompt.text({
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
  Command.run({
    version: "0.0.1",
  }),
  Effect.provide([
    NodeServices.layer,
    Kvs,
    NodeHttpClient.layerUndici,
    NodeSocket.layerWebSocketConstructorWS,
  ]),
  NodeRuntime.runMain,
)

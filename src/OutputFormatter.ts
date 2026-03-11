/**
 * @since 1.0.0
 */
import { Effect, Layer, PubSub, Semaphore, ServiceMap, Stream } from "effect"
import { type Output, AgentFinished } from "./Agent.ts"
import chalk from "chalk"

/**
 * @since 1.0.0
 * @category Models
 */
export type OutputFormatter = <E, R>(
  stream: Stream.Stream<Output, AgentFinished | E, R>,
) => Stream.Stream<string, Exclude<E, AgentFinished>, R>

/**
 * @since 1.0.0
 * @category Pretty
 */
export const pretty: OutputFormatter = (stream) =>
  stream.pipe(
    Stream.map((output) => {
      let prefix = ""
      if (output._tag === "SubagentPart") {
        prefix = chalk.magenta(`Subagent #${output.id}:`) + " "
        output = output.part
      }
      switch (output._tag) {
        case "SubagentStart": {
          return `${chalkSubagentHeading(`${subagentIcon} Subagent #${output.id} starting (${output.modelAndProvider})`)}

${chalk.dim(output.prompt)}\n\n`
        }
        case "SubagentComplete": {
          return `${chalkSubagentHeading(`${subagentIcon} Subagent #${output.id} complete`)}

${output.summary}\n\n`
        }
        case "ReasoningStart": {
          return (
            prefix + chalkReasoningHeading(`${thinkingIcon} Thinking:`) + " "
          )
        }
        case "ReasoningDelta": {
          return output.delta
        }
        case "ReasoningEnd": {
          return "\n\n"
        }
        case "ScriptStart": {
          return `${prefix}${chalkScriptHeading(`${scriptIcon} Executing script`)}\n\n`
        }
        case "ScriptDelta": {
          return chalk.dim(output.delta)
        }
        case "ScriptEnd": {
          return "\n\n"
        }
        case "ScriptOutput": {
          const lines = output.output.split("\n")
          const truncated =
            lines.length > 20
              ? lines.slice(0, 20).join("\n") + "\n... (truncated)"
              : output.output
          return `${prefix}${chalkScriptHeading(`${scriptIcon} Script output`)}\n\n${chalk.dim(truncated)}\n\n`
        }
      }
    }),
    Stream.catchTag("AgentFinished", (finished) =>
      Stream.succeed(
        `\n${chalk.bold.green(`${doneIcon} Task complete:`)}\n\n${(finished as AgentFinished).summary}`,
      ),
    ),
  )

const chalkScriptHeading = chalk.bold.blue
const chalkSubagentHeading = chalk.bold.magenta
const chalkReasoningHeading = chalk.bold.yellow

const scriptIcon = "\u{f0bc1}"
const subagentIcon = "\u{ee0d} "
const thinkingIcon = "\u{f07f6}"
const doneIcon = "\u{eab2}"

/**
 * @since 1.0.0
 * @category Muxer
 */
export class Muxer extends ServiceMap.Service<
  Muxer,
  {
    add<E, R>(
      agent: Stream.Stream<Output, AgentFinished | E, R>,
    ): Effect.Effect<void, never, R>
    readonly output: Stream.Stream<string>
  }
>()("clanka/OutputFormatter/Muxer") {}

/**
 * @since 1.0.0
 * @category Muxer
 */
export const layerMuxer = (formatter: OutputFormatter) =>
  Layer.effect(
    Muxer,
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const output = yield* PubSub.unbounded<string>()
      let agentCount = 0
      let currentAgentId: number | null = null
      const semaphore = Semaphore.makeUnsafe(1)

      return Muxer.of({
        add(stream) {
          const id = ++agentCount
          return stream.pipe(
            Stream.tap(
              Effect.fnUntraced(function* (part_) {
                if (currentAgentId === null || id !== currentAgentId) {
                  yield* semaphore.take(1)
                }
                const part = part_._tag === "SubagentPart" ? part_.part : part_
                switch (part._tag) {
                  case "ReasoningStart":
                  case "ScriptStart": {
                    currentAgentId = id
                    break
                  }
                  case "ScriptDelta":
                  case "ReasoningDelta": {
                    break
                  }
                  default: {
                    currentAgentId = null
                    break
                  }
                }
                if (id !== currentAgentId) {
                  yield* semaphore.release(1)
                }
              }),
            ),
            formatter,
            Stream.runIntoPubSub(output),
            Effect.onExit(() => {
              if (currentAgentId !== id) return Effect.void
              currentAgentId = null
              return semaphore.release(1)
            }),
            Effect.forkIn(scope),
            Effect.asVoid,
          )
        },
        output: Stream.fromPubSub(output),
      })
    }),
  )

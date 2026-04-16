/**
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PubSub from "effect/PubSub"
import * as Semaphore from "effect/Semaphore"
import * as Context from "effect/Context"
import * as Stream from "effect/Stream"
import type { AgentFinished, Output } from "./AgentOutput.ts"
import chalk from "chalk"
import type * as Prompt from "effect/unstable/ai/Prompt"
import * as Cause from "effect/Cause"
import { identity } from "effect/Function"

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
export const pretty = (options?: {
  readonly outputTruncation?: number | boolean | undefined
}): OutputFormatter => {
  const maxLines =
    typeof options?.outputTruncation === "number"
      ? options.outputTruncation
      : 20
  const truncate =
    options?.outputTruncation === true ||
    typeof options?.outputTruncation === "number"
      ? (text: string): string => {
          const lines = text.split("\n")
          if (lines.length > maxLines) {
            return (
              lines.slice(0, maxLines).join("\n") +
              `\n... (truncated, total ${lines.length} lines)`
            )
          }
          return text
        }
      : identity
  return (stream) =>
    stream.pipe(
      Stream.map((output) => {
        let prefix = ""
        if (output._tag === "SubagentPart") {
          prefix = chalk.magenta(`Subagent #${output.id}:`) + " "
          output = output.part
        }
        switch (output._tag) {
          case "AgentStart": {
            return `${chalkAgentHeading(`${subagentIcon} Agent #${output.id} starting (${output.modelAndProvider})`)}\n\n${promptToString(output.prompt)}\n\n`
          }
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
            return `${prefix}${chalkScriptHeading(`${scriptIcon} Script output`)}\n\n${chalk.dim(truncate(output.output))}\n\n`
          }
          case "ErrorRetry": {
            return `${prefix}${chalk.red(`Error: ${output.error.reason._tag}. Retrying...`)}\n\n${chalk.dim(Cause.pretty(Cause.fail(output.error)))}\n\n`
          }
          case "Usage": {
            return `${prefix}${chalkInfoHeading(`${infoIcon} Usage:`)} ${numberFormat.format(output.contextTokens)} context / ${numberFormat.format(output.inputTokens)} input / ${numberFormat.format(output.outputTokens)} output\n\n`
          }
        }
      }),
      Stream.catchTag("AgentFinished", (finished) =>
        Stream.succeed(
          `\n${chalk.bold.green(`${doneIcon} Task complete:`)}\n\n${(finished as AgentFinished).summary}`,
        ),
      ),
    )
}

const promptToString = (prompt: Prompt.Prompt): string => {
  let textParts: Array<string> = []
  for (const message of prompt.content) {
    if (message.role !== "user") continue
    let content = message.content
    for (const part of content) {
      if (part.type !== "text") continue
      textParts.push(part.text)
    }
  }
  return textParts.join("\n")
}

const numberFormat = new Intl.NumberFormat()

const chalkAgentHeading = chalk.bold.green
const chalkScriptHeading = chalk.bold.blue
const chalkSubagentHeading = chalk.bold.magenta
const chalkReasoningHeading = chalk.bold.yellow
const chalkInfoHeading = chalk.bold.cyan

const scriptIcon = "\u{f0bc1}"
const subagentIcon = "\u{ee0d} "
const thinkingIcon = "\u{f07f6}"
const doneIcon = "\u{eab2}"
const infoIcon = "\u{f05a}"

/**
 * @since 1.0.0
 * @category Muxer
 */
export class Muxer extends Context.Service<
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

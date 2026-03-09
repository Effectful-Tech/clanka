/**
 * @since 1.0.0
 */
import { Stream } from "effect"
import { type Output, AgentFinished } from "./Agent.ts"
import chalk from "chalk"

/**
 * @since 1.0.0
 * @category Models
 */
export type OutputFormatter<E = never, R = never> = (
  stream: Stream.Stream<Output, AgentFinished>,
) => Stream.Stream<string, E, R>

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
          return `${prefix}${chalkScriptHeading(`${scriptIcon} Executing script`)}\n\n${chalk.dim(output.script)}\n\n`
        }
        case "ScriptEnd": {
          const lines = output.output.split("\n")
          const truncated =
            lines.length > 20
              ? lines.slice(0, 20).join("\n") + "\n... (truncated)"
              : output.output
          return `${prefix}${chalkScriptHeading(`${scriptIcon} Script output`)}\n\n${chalk.dim(truncated)}\n\n`
        }
      }
    }),
    Stream.catch((finished) =>
      Stream.succeed(
        `\n${chalk.bold.green(`${doneIcon} Task complete:`)}\n\n${finished.summary}`,
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

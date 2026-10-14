/**
 * Find the AGENTS.md files and skills that apply to a directory, and render
 * them for the model.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as AgentSkills from "./AgentSkills.ts"

/**
 * The most characters of one AGENTS.md sent to the model.
 *
 * @since 1.0.0
 * @category Constants
 */
export const maxInstructionsChars = 32_000

/**
 * An AGENTS.md file and the directory it applies to.
 *
 * @since 1.0.0
 * @category Models
 */
export interface Instructions {
  readonly id: string
  readonly path: string
  readonly directory: string
  readonly content: string
}

/**
 * @since 1.0.0
 * @category Models
 */
export interface Discovered {
  /** Outermost directory first. */
  readonly instructions: ReadonlyArray<Instructions>
  /** Outermost directory first. */
  readonly skills: ReadonlyArray<AgentSkills.Skill>
}

/**
 * The id that records whether a skill has been sent to the model.
 *
 * @since 1.0.0
 * @category Models
 */
export const skillId = (skill: AgentSkills.Skill): string =>
  `skill:${skill.location}`

/**
 * The AGENTS.md files and project skills from `cwd` up to the startup
 * directory when `cwd` is inside it, or else up to the nearest git root. The
 * walk never goes up into `home` or the filesystem root.
 *
 * @since 1.0.0
 * @category Discovery
 */
export const discover = Effect.fnUntraced(function* (options: {
  readonly cwd: string
  readonly startup: string
  readonly home: Option.Option<string>
}): Effect.fn.Return<Discovered, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const relative = path.relative(options.startup, options.cwd)
  // `..pkg` is a child, so compare the first path segment, not a prefix.
  const inside =
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)

  const directories: Array<string> = []
  let directory = options.cwd
  while (true) {
    directories.push(directory)
    if (
      inside
        ? directory === options.startup
        : yield* fs
            .exists(path.join(directory, ".git"))
            .pipe(Effect.orElseSucceed(() => false))
    ) {
      break
    }
    const parent = path.dirname(directory)
    if (
      parent === directory ||
      parent === path.parse(parent).root ||
      (Option.isSome(options.home) && parent === options.home.value)
    ) {
      break
    }
    directory = parent
  }
  directories.reverse()

  const instructions: Array<Instructions> = []
  const skills: Array<AgentSkills.Skill> = []
  for (const directory of directories) {
    const file = path.join(directory, "AGENTS.md")
    const content = yield* Effect.option(fs.readFileString(file))
    if (Option.isSome(content) && content.value.trim() !== "") {
      instructions.push({
        id: `AGENTS.md:${file}`,
        path: file,
        directory,
        content: cap(content.value),
      })
    }
    skills.push(...(yield* AgentSkills.discoverProject(directory)))
  }
  return { instructions, skills }
})

const cap = (content: string) =>
  content.length <= maxInstructionsChars
    ? content
    : `${content.slice(0, maxInstructionsChars)}\n\n[Truncated: the file has ${content.length} characters; read it for the rest.]`

/**
 * One AGENTS.md as the model sees it, in the system prompt and in updates.
 *
 * @since 1.0.0
 * @category Rendering
 */
export const renderInstructions = (instructions: Instructions) => `# AGENTS.md

The following instructions are from ${instructions.path}.
They apply when working under ${instructions.directory}.
You do not need to read this file again.

**ALWAYS follow these instructions when working under ${instructions.directory}**:

<!-- AGENTS.md start -->
${instructions.content}
<!-- AGENTS.md end -->`

/**
 * The text of an environment update: new AGENTS.md files, outermost first,
 * then new skills.
 *
 * @since 1.0.0
 * @category Rendering
 */
export const renderUpdate = (discovered: Discovered): string => {
  const sections = discovered.instructions.map(renderInstructions)
  if (discovered.skills.length > 0) {
    sections.push(`# Skills

New skills are available, in addition to those listed before. A skill listed
here takes precedence over an earlier skill with the same name. Read a skill's
file with "readFile" before a task that matches its description.

${AgentSkills.renderEntries(discovered.skills)}`)
  }
  return sections.join("\n\n")
}

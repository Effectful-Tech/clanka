/**
 * Discovery of Agent Skills (https://agentskills.io/specification) on the
 * executor filesystem.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Yaml from "effect/unstable/encoding/Yaml"

/**
 * @since 1.0.0
 * @category Models
 */
export const SkillSource = Schema.Literals(["project", "user"])

/**
 * @since 1.0.0
 * @category Models
 */
export type SkillSource = typeof SkillSource.Type

/**
 * A skill discovered on the executor filesystem.
 *
 * `location` is the absolute path to the `SKILL.md` file, and must be
 * openable from the executor (where `readFile` runs).
 *
 * @since 1.0.0
 * @category Models
 */
export class Skill extends Schema.Class<Skill>("Skill")({
  name: Schema.String,
  description: Schema.String,
  location: Schema.String,
  source: SkillSource,
}) {}

/**
 * Discover skills from `<directory>/.agents/skills/<dir>/SKILL.md` (project)
 * and `<homeDirectory>/.agents/skills/<dir>/SKILL.md` (user).
 *
 * Skills are keyed by their frontmatter `name`. A project skill hides a user
 * skill with the same name; within a scope the first one found wins. Skills
 * with unparseable frontmatter or a missing `description` are skipped, and no
 * filesystem problem ever fails discovery.
 *
 * @since 1.0.0
 * @category Discovery
 */
export const discover: (options: {
  readonly directory: string
  readonly homeDirectory: Option.Option<string>
}) => Effect.Effect<
  ReadonlyArray<Skill>,
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.fnUntraced(function* (options) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const roots: Array<{ readonly root: string; readonly source: SkillSource }> =
    [{ root: options.directory, source: "project" }]
  if (Option.isSome(options.homeDirectory)) {
    roots.push({ root: options.homeDirectory.value, source: "user" })
  }

  const byName = new Map<string, Skill>()
  for (const { root, source } of roots) {
    const skillsDir = path.resolve(root, ".agents", "skills")
    const entries = yield* fs
      .readDirectory(skillsDir)
      .pipe(Effect.orElseSucceed(() => []))
    entries.sort()
    for (const entry of entries) {
      const location = path.join(skillsDir, entry, "SKILL.md")
      const content = yield* Effect.option(fs.readFileString(location))
      if (Option.isNone(content)) continue
      const frontmatter = parseFrontmatter(content.value)
      if (Option.isNone(frontmatter)) continue
      const description = singleLine(frontmatter.value.description)
      if (description === "") continue
      const name = Predicate.isString(frontmatter.value.name)
        ? singleLine(frontmatter.value.name) || entry
        : entry
      if (byName.has(name)) continue
      byName.set(name, new Skill({ name, description, location, source }))
    }
  }

  return Array.from(byName.values())
})

/**
 * Render the catalog as a system prompt section, or `None` when there are no
 * skills to disclose.
 *
 * @since 1.0.0
 * @category Rendering
 */
export const renderCatalog = (
  skills: ReadonlyArray<Skill>,
): Option.Option<string> => {
  if (skills.length === 0) return Option.none()
  const entries = skills
    .map(
      (skill) => `- ${skill.name}: ${skill.description}
  location: ${skill.location}`,
    )
    .join("\n")
  return Option.some(`# Skills

The following skills are available. Each one is a folder with instructions for
a specific kind of task.

When a task matches a skill's description, use "readFile" to read the file at
its location BEFORE proceeding, then follow the instructions it contains.
Relative paths mentioned inside a skill (such as "scripts/" or "references/")
are relative to the skill's directory (the parent of SKILL.md); use absolute
paths when accessing them.

${entries}`)
}

// ------------------------------------------
// Internal
// -------------------------------------------

const Frontmatter = Schema.Struct({
  name: Schema.optional(Schema.Unknown),
  description: Schema.String,
})

const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)

const frontmatterPattern = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * Read the YAML frontmatter block of a `SKILL.md`. The whole block has to
 * parse, so a skill with malformed frontmatter is skipped even when its
 * `description` looks fine.
 */
const parseFrontmatter = (
  content: string,
): Option.Option<typeof Frontmatter.Type> => {
  const match = frontmatterPattern.exec(content)
  if (match === null) return Option.none()
  try {
    return decodeFrontmatter(Yaml.parse(match[1]!))
  } catch {
    return Option.none()
  }
}

// Catalog entries are single lines, so a value can never break out of its entry.
const singleLine = (value: string): string => value.replace(/\s+/g, " ").trim()

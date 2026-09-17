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
      const content = yield* Effect.option(
        fs.stat(location).pipe(
          Effect.filterOrFail((info) => info.type === "File"),
          Effect.andThen(fs.readFileString(location)),
        ),
      )
      if (Option.isNone(content)) continue
      const frontmatter = parseFrontmatter(content.value)
      if (Option.isNone(frontmatter)) continue
      const description = frontmatter.value.description
        .replace(/\s+/g, " ")
        .trim()
      if (!description) continue
      const name = Schema.is(Schema.String)(frontmatter.value.name)
        ? frontmatter.value.name.trim() || entry
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
      (
        skill,
      ) => `- ${skill.name.replace(/\s+/g, " ")}: ${skill.description.replace(/\s+/g, " ")}
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

const decodeFrontmatter = Schema.decodeUnknownOption(
  Schema.Struct({
    name: Schema.optional(Schema.Unknown),
    description: Schema.String,
  }),
)

const parseYaml = Option.liftThrowable((source: string): unknown =>
  Yaml.parse(source),
)

/**
 * Parse the whole frontmatter block with effect's YAML parser, so a skill with
 * malformed frontmatter is skipped even when its `description` looks fine.
 * Plain scalars may contain unquoted colons.
 */
const parseFrontmatter = (
  content: string,
): Option.Option<{ readonly name?: unknown; readonly description: string }> => {
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return Option.none()
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  )
  if (end === -1) return Option.none()

  return parseYaml(lines.slice(1, end).join("\n")).pipe(
    Option.flatMap(decodeFrontmatter),
  )
}

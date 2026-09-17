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
      const description = frontmatter.value.get("description")?.trim()
      if (!description) continue
      const name = frontmatter.value.get("name")?.trim() || entry
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

const frontmatterKey = /^([A-Za-z0-9_-]+):(.*)$/

/**
 * A lenient YAML frontmatter reader.
 *
 * Only top-level `key: value` pairs are extracted. Nested mappings are
 * ignored, block scalars (`|`, `>`) are joined, and unquoted colons inside a
 * value are kept as-is. Returns `None` when the frontmatter block is missing
 * or contains a top-level line that cannot be read as a key.
 */
const parseFrontmatter = (
  content: string,
): Option.Option<ReadonlyMap<string, string>> => {
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return Option.none()
  const end = lines.indexOf("---", 1)
  if (end === -1) return Option.none()

  const result = new Map<string, string>()
  let i = 1
  while (i < end) {
    const line = lines[i]!
    i++
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    if (/^\s/.test(line)) continue // nested content of a previous key
    const match = frontmatterKey.exec(line)
    if (!match) return Option.none()
    const key = match[1]!
    let value = match[2]!.trim()
    const block = /^[|>][-+]?$/.test(value)
    if (block || value === "") {
      const folded = value.startsWith(">")
      const parts: Array<string> = []
      while (i < end && (/^\s/.test(lines[i]!) || lines[i]!.trim() === "")) {
        parts.push(lines[i]!.trim())
        i++
      }
      // An empty value followed by indented lines is a nested mapping, which
      // is not needed for the catalog.
      value = block ? parts.join(folded ? " " : "\n").trim() : ""
    } else {
      value = unquote(value)
    }
    if (!result.has(key)) result.set(key, value)
  }
  return Option.some(result)
}

const unquote = (value: string): string => {
  const first = value[0]
  const last = value[value.length - 1]
  if (value.length >= 2 && first === last && (first === '"' || first === "'")) {
    return value.slice(1, -1)
  }
  return value
}

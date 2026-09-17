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

  const frontmatter = lines.slice(1, end)
  return parseYaml(frontmatter.join("\n")).pipe(
    Option.orElse(() => parseYaml(normalizeFrontmatter(frontmatter))),
    Option.flatMap(decodeFrontmatter),
  )
}

/**
 * Adapt two YAML shapes unsupported by Effect's configuration parser. Keep
 * every field for the subsequent full-document parse; never skip bad lines.
 */
const normalizeFrontmatter = (lines: ReadonlyArray<string>): string => {
  const normalized = [...lines]
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!/^[^\s#][^:]*:[ \t]*(?:#.*)?$/.test(line)) continue

    let start = i + 1
    while (start < lines.length && /^\s*(?:#.*)?$/.test(lines[start]!)) start++
    if (start === lines.length) continue

    // An indentless sequence is a value of the preceding empty mapping key.
    // Move its items and their nested content together, preserving indentation.
    if (/^-(?: |$)/.test(lines[start]!)) {
      let end = start
      while (
        end < lines.length &&
        (/^-(?: |$)/.test(lines[end]!) ||
          /^\s/.test(lines[end]!) ||
          /^#|^$/.test(lines[end]!))
      ) {
        normalized[end] = `  ${lines[end]!}`
        end++
      }
      i = end - 1
      continue
    }

    if (!line.startsWith("description:")) continue
    const first = lines[start]!
    const indent = /^ +/.exec(first)?.[0]
    if (!indent) continue
    // A mapping, collection, quoted value or block scalar is not a plain
    // description. Leave those to the parser rather than turning them into text.
    if (
      /^["'[\]{}|>&*!#%@`]/.test(first.trimStart()) ||
      /^[-?:](?:\s|$)/.test(first.trimStart())
    )
      continue

    let end = start
    const parts: Array<string> = []
    let plain = true
    while (
      end < lines.length &&
      (/^\s/.test(lines[end]!) || /^#|^$/.test(lines[end]!))
    ) {
      const current = lines[end]!
      if (/^\s*(?:#.*)?$/.test(current)) {
        parts.push("")
      } else {
        const text = current.replace(/[ \t]+#.*$/, "")
        // Do not hide nested mappings or invalid indentation in a block scalar.
        if (
          /^ +/.exec(current)?.[0] !== indent ||
          /:\s|:$/.test(text) ||
          /^ *\t/.test(current)
        )
          plain = false
        parts.push(text)
      }
      end++
    }
    if (plain && parts.length > 1) {
      normalized[i] = "description: >-"
      for (let j = start; j < end; j++) normalized[j] = parts[j - start]!
    }
    i = end - 1
  }
  return normalized.join("\n")
}

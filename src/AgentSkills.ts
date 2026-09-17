/**
 * Discover Agent Skills (https://agentskills.io/specification) on the executor.
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
 * Skill metadata with an absolute executor-side `SKILL.md` path.
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
 * Scan project and user `.agents/skills/<dir>/SKILL.md` files, plus
 * `<hermesHome>/skills/<dir>/SKILL.md` when explicitly configured.
 *
 * Project names override Hermes names, which override user names.
 * The first name wins within each scope; an empty Hermes home is ignored.
 * Skip unreadable files, invalid frontmatter and missing or empty descriptions.
 *
 * @since 1.0.0
 * @category Discovery
 */
export const discover: (options: {
  readonly directory: string
  readonly homeDirectory: Option.Option<string>
  readonly hermesHome?: Option.Option<string>
}) => Effect.Effect<
  ReadonlyArray<Skill>,
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.fnUntraced(function* (options) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const roots: Array<{ readonly root: string; readonly source: SkillSource }> =
    [
      {
        root: path.resolve(options.directory, ".agents", "skills"),
        source: "project",
      },
    ]
  if (
    options.hermesHome &&
    Option.isSome(options.hermesHome) &&
    options.hermesHome.value !== ""
  ) {
    roots.push({
      root: path.resolve(options.hermesHome.value, "skills"),
      source: "user",
    })
  }
  if (Option.isSome(options.homeDirectory)) {
    roots.push({
      root: path.resolve(options.homeDirectory.value, ".agents", "skills"),
      source: "user",
    })
  }

  const byName = new Map<string, Skill>()
  for (const { root: skillsDir, source } of roots) {
    const entries = yield* fs
      .readDirectory(skillsDir)
      .pipe(Effect.orElseSucceed(() => []))
    entries.sort()
    for (const entry of entries) {
      const location = path.join(skillsDir, entry, "SKILL.md")
      const content = yield* Effect.option(
        fs.stat(location).pipe(
          Effect.filterOrFail((info) => info.type === "File"),
          Effect.andThen(() => fs.readFileString(location)),
        ),
      )
      if (Option.isNone(content)) continue
      const frontmatter = parseFrontmatter(content.value)
      if (Option.isNone(frontmatter)) continue
      const description = singleLine(frontmatter.value.description)
      if (description === "") continue
      const name = Predicate.isString(frontmatter.value.name)
        ? singleLine(frontmatter.value.name) || singleLine(entry)
        : singleLine(entry)
      if (byName.has(name)) continue
      byName.set(name, new Skill({ name, description, location, source }))
    }
  }

  return Array.from(byName.values())
})

/**
 * Render the skills prompt section, or `None` for an empty catalog.
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
  location: ${renderLocation(skill.location)}`,
    )
    .join("\n")
  return Option.some(`# Skills

The following skills are available. Each one is a folder with instructions for
a specific kind of task.

When a task matches a skill's description, use "readFile" to read the file at
its location BEFORE proceeding, then follow the instructions it contains.
Double-quoted locations are JSON strings; decode them to get the exact file
path. Unquoted locations are literal paths.
Relative paths mentioned inside a skill (such as "scripts/" or "references/")
are relative to the skill's directory (the parent of SKILL.md); use absolute
paths when accessing them.

${entries}`)
}

const Frontmatter = Schema.Struct({
  name: Schema.optional(Schema.Unknown),
  description: Schema.String,
})

const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)

const frontmatterPattern = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

// Validate all frontmatter, including fields omitted from the catalog.
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

const singleLine = (value: string): string => value.replace(/\s+/g, " ").trim()

const renderLocation = (location: string): string => {
  const encoded = JSON.stringify(location)
  return encoded.slice(1, -1) === location ? location : encoded
}

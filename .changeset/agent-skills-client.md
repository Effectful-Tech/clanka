---
"clanka": minor
---

Add Agent Skills client support. Skills in `<cwd>/.agents/skills/<dir>/SKILL.md` and `$HOME/.agents/skills/<dir>/SKILL.md` are discovered on the executor filesystem, exposed on `AgentExecutor.Capabilities.skills`, and listed in the system prompt so the model can `readFile` a matching skill on demand.

Frontmatter is parsed with effect's YAML parser, descriptions are normalized to one line for the catalog, and `skills` defaults to an empty list when decoding or constructing capabilities.

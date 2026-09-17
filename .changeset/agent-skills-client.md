---
"clanka": minor
---

Add Agent Skills client support. Skills in `<cwd>/.agents/skills/<dir>/SKILL.md` and `$HOME/.agents/skills/<dir>/SKILL.md` are discovered on the executor filesystem, exposed on `AgentExecutor.Capabilities.skills`, and listed in the system prompt so the model can `readFile` a matching skill on demand.

Validate YAML frontmatter while recovering unquoted colons in descriptions, normalize multiline descriptions for the catalog, and default `skills` to an empty list when decoding or constructing capabilities.

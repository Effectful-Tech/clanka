---
"clanka": patch
---

Unwrap `Result` values returned by `Yaml.parse` during agent skill frontmatter discovery so skills continue to load on newer Effect builds where `Yaml.parse` returns a `Result`.

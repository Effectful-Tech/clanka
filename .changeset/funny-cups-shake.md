---
"clanka": patch
---

Switch CodeChunker to tree-sitter AST chunking for JavaScript and TypeScript files, add chunk metadata fields (name, type, parent), and remove contentHash from chunks. SemanticSearch now computes chunk hashes from embedding input instead.

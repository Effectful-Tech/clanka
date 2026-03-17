---
"clanka": minor
---

Replace `SemanticSearch.reindex` with file-specific index update methods.

- Add `SemanticSearch.updateFile(path)` to re-chunk and re-embed a single file.
- Add `SemanticSearch.removeFile(path)` to remove a single file from the index.
- Add `CodeChunker.chunkFile` and `CodeChunker.chunkFiles` for targeted chunking.
- Update `AgentTools` file mutation handlers to call targeted semantic index updates instead of global reindexing.

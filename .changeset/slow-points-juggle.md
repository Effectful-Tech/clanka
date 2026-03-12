---
"clanka": patch
---

Use `HttpClient.followRedirects()` in `WebToMarkdown` so redirected URLs are fetched successfully before markdown conversion. Added a regression test covering a 302 redirect flow in `WebToMarkdown.convertUrl`.

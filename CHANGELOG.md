# clanka

## 0.2.8

### Patch Changes

- [`1fbe66c`](https://github.com/Effectful-Tech/clanka/commit/1fbe66c1702220e3e1c2d2b4370bbcc90dfc77ca) Thanks [@tim-smart](https://github.com/tim-smart)! - bump treesitter versions

## 0.2.7

### Patch Changes

- [`a37a374`](https://github.com/Effectful-Tech/clanka/commit/a37a37473f8f3639d8e61553c35ad3cbc6a9f51f) Thanks [@tim-smart](https://github.com/tim-smart)! - update tree sitter parsers

## 0.2.6

### Patch Changes

- [#93](https://github.com/Effectful-Tech/clanka/pull/93) [`90ef4b7`](https://github.com/Effectful-Tech/clanka/commit/90ef4b7537033b2f024652c8d9ecca182db237cb) Thanks [@tim-smart](https://github.com/tim-smart)! - Switch CodeChunker to tree-sitter AST chunking for JavaScript and TypeScript files, add chunk metadata fields (name, type, parent), and remove contentHash from chunks. SemanticSearch now computes chunk hashes from embedding input instead.

## 0.2.5

### Patch Changes

- [#94](https://github.com/Effectful-Tech/clanka/pull/94) [`9489743`](https://github.com/Effectful-Tech/clanka/commit/9489743dd485770ac61c3b909b93477a0c6c1327) Thanks [@tim-smart](https://github.com/tim-smart)! - Fix SemanticSearch embedding resolver wiring so `embeddingRequestDelay` controls `RequestResolver.setDelay` (defaulting to 50ms), instead of incorrectly deriving delay from `embeddingBatchSize`. Add regression tests for explicit and default delay behavior.

- [`54fb2b8`](https://github.com/Effectful-Tech/clanka/commit/54fb2b89f5e64d2b280dbbd60c5983cbf2fd1773) Thanks [@tim-smart](https://github.com/tim-smart)! - demote delegate tool

## 0.2.4

### Patch Changes

- [`48008dd`](https://github.com/Effectful-Tech/clanka/commit/48008dd32ee9e3238077c78ad684d63ae7685aae) Thanks [@tim-smart](https://github.com/tim-smart)! - prompt tweaks

## 0.2.3

### Patch Changes

- [`75c9040`](https://github.com/Effectful-Tech/clanka/commit/75c904068ffee38365a52afd4ddfe81be12d8d26) Thanks [@tim-smart](https://github.com/tim-smart)! - reset log anotations for executor

## 0.2.2

### Patch Changes

- [`a2d025a`](https://github.com/Effectful-Tech/clanka/commit/a2d025a5cc25c5127c648484a57b3beb7d1e5cad) Thanks [@tim-smart](https://github.com/tim-smart)! - prompt tweaks

## 0.2.1

### Patch Changes

- [`4b21675`](https://github.com/Effectful-Tech/clanka/commit/4b2167594eeb6f9b8c5c9b0cefa6111a7c5ee8f5) Thanks [@tim-smart](https://github.com/tim-smart)! - seperate context tokens from input in usage

## 0.2.0

### Minor Changes

- [#84](https://github.com/Effectful-Tech/clanka/pull/84) [`19a9c1a`](https://github.com/Effectful-Tech/clanka/commit/19a9c1a9d145317e3da01e34c4834b620d4a2572) Thanks [@tim-smart](https://github.com/tim-smart)! - Replace `SemanticSearch.reindex` with file-specific index update methods.
  - Add `SemanticSearch.updateFile(path)` to re-chunk and re-embed a single file.
  - Add `SemanticSearch.removeFile(path)` to remove a single file from the index.
  - Add `CodeChunker.chunkFile` and `CodeChunker.chunkFiles` for targeted chunking.
  - Update `AgentTools` file mutation handlers to call targeted semantic index updates instead of global reindexing.

## 0.1.22

### Patch Changes

- [`ac822c5`](https://github.com/Effectful-Tech/clanka/commit/ac822c5540b20a1f0e926ab291bcb3239a2caa32) Thanks [@tim-smart](https://github.com/tim-smart)! - remove console.log

## 0.1.21

### Patch Changes

- [#80](https://github.com/Effectful-Tech/clanka/pull/80) [`fdd0ff7`](https://github.com/Effectful-Tech/clanka/commit/fdd0ff7e20b6fada7d702c66da9bb6ddb32736b3) Thanks [@tim-smart](https://github.com/tim-smart)! - Add `SemanticSearch`

## 0.1.20

### Patch Changes

- [`c605265`](https://github.com/Effectful-Tech/clanka/commit/c605265f57e7040d819f2324e820fd4224bd82f9) Thanks [@tim-smart](https://github.com/tim-smart)! - use rg max columns

## 0.1.19

### Patch Changes

- [`075d63a`](https://github.com/Effectful-Tech/clanka/commit/075d63af70bc02ef6cd1f3d73245f3b95771f5d8) Thanks [@tim-smart](https://github.com/tim-smart)! - use rg --header

## 0.1.18

### Patch Changes

- [`60294d5`](https://github.com/Effectful-Tech/clanka/commit/60294d50d09e8112f95c9da404e410e3daa4116a) Thanks [@tim-smart](https://github.com/tim-smart)! - output Usage parts

## 0.1.17

### Patch Changes

- [`41d5f59`](https://github.com/Effectful-Tech/clanka/commit/41d5f590b09ee59d62dce341d92b2361f32453bb) Thanks [@tim-smart](https://github.com/tim-smart)! - ws errors

## 0.1.16

### Patch Changes

- [`9274f21`](https://github.com/Effectful-Tech/clanka/commit/9274f215ada02c0d4fd75e054ba3caf7970dcda3) Thanks [@tim-smart](https://github.com/tim-smart)! - prompt tweakd

## 0.1.15

### Patch Changes

- [`3983176`](https://github.com/Effectful-Tech/clanka/commit/398317663b9d988490fdabb44229dbcf6336adb2) Thanks [@tim-smart](https://github.com/tim-smart)! - improve Layer memoization

## 0.1.14

### Patch Changes

- [`db0d855`](https://github.com/Effectful-Tech/clanka/commit/db0d8555c154a1cfdeb0850d4572f48d2e621873) Thanks [@tim-smart](https://github.com/tim-smart)! - update effect

## 0.1.13

### Patch Changes

- [`19beec6`](https://github.com/Effectful-Tech/clanka/commit/19beec6549616ac4d409e7f97354cd6885faf986) Thanks [@tim-smart](https://github.com/tim-smart)! - update effect

## 0.1.12

### Patch Changes

- [`b817eeb`](https://github.com/Effectful-Tech/clanka/commit/b817eebadcef5cd7bf82160a444ca5f9cefee47c) Thanks [@tim-smart](https://github.com/tim-smart)! - switch to single tool only

## 0.1.11

### Patch Changes

- [`cf50ca4`](https://github.com/Effectful-Tech/clanka/commit/cf50ca459008728dbd74018af78b9f56ef812d9b) Thanks [@tim-smart](https://github.com/tim-smart)! - use duration format

## 0.1.10

### Patch Changes

- [`216f37b`](https://github.com/Effectful-Tech/clanka/commit/216f37b0559547e622835a642634dd5069c457f8) Thanks [@tim-smart](https://github.com/tim-smart)! - improve tool instructions

## 0.1.9

### Patch Changes

- [`de281e5`](https://github.com/Effectful-Tech/clanka/commit/de281e5ad7220b129ca780f55c819139159bfe92) Thanks [@tim-smart](https://github.com/tim-smart)! - remove "Javascript output" from output

## 0.1.8

### Patch Changes

- [`201bf24`](https://github.com/Effectful-Tech/clanka/commit/201bf24f206309b35dec7d25f58a5cb8affea19f) Thanks [@tim-smart](https://github.com/tim-smart)! - use ms for bash timeout

## 0.1.7

### Patch Changes

- [#65](https://github.com/Effectful-Tech/clanka/pull/65) [`96bd44b`](https://github.com/Effectful-Tech/clanka/commit/96bd44b57d87cea7f8777f975ab6685c69bae434) Thanks [@tim-smart](https://github.com/tim-smart)! - Add an optional `timeout` field to the `bash` tool parameters and change the `bash` tool input shape to `{ command, timeout? }` (with `command` as the parameter name in rendered typings).

  The timeout is specified in seconds and defaults to 120 seconds.

## 0.1.6

### Patch Changes

- [`c37b725`](https://github.com/Effectful-Tech/clanka/commit/c37b72521afc876d3f95b1a39c416f98690f095c) Thanks [@tim-smart](https://github.com/tim-smart)! - clean up imports

- [`1aac21a`](https://github.com/Effectful-Tech/clanka/commit/1aac21a26cd097afe5cedb31d7813ea15af8ed1e) Thanks [@tim-smart](https://github.com/tim-smart)! - add note about not sharing variables

## 0.1.5

### Patch Changes

- [`f2d5219`](https://github.com/Effectful-Tech/clanka/commit/f2d52197f271723d3bc1bb8388bb4e3071370000) Thanks [@tim-smart](https://github.com/tim-smart)! - improve claude support

## 0.1.4

### Patch Changes

- [#61](https://github.com/Effectful-Tech/clanka/pull/61) [`a4d55da`](https://github.com/Effectful-Tech/clanka/commit/a4d55da778a37bc456315124e3c6e894ecb4a4de) Thanks [@tim-smart](https://github.com/tim-smart)! - Add a new `search` AgentTool that spawns a subagent from a textual search description and returns its findings.

  The `search` subagent is explicitly instructed not to call `search` recursively, and to return a concise report with file paths, line numbers, and code snippets.

## 0.1.3

### Patch Changes

- [`ad9b2da`](https://github.com/Effectful-Tech/clanka/commit/ad9b2da9371aab7122f3e15bd3c64e960f06aa15) Thanks [@tim-smart](https://github.com/tim-smart)! - remove rg noIgnore option

- [#60](https://github.com/Effectful-Tech/clanka/pull/60) [`e9dd2e3`](https://github.com/Effectful-Tech/clanka/commit/e9dd2e3690b20a34e96cd17f8174058288410656) Thanks [@tim-smart](https://github.com/tim-smart)! - Strip a single outer markdown code fence before passing generated scripts to the executor, so wrapped JavaScript responses execute directly.

## 0.1.2

### Patch Changes

- [`4e2721e`](https://github.com/Effectful-Tech/clanka/commit/4e2721e8c9acae4fff14af56862231e1e7636d9c) Thanks [@tim-smart](https://github.com/tim-smart)! - add Rpc layers for AgentExecutor

## 0.1.1

### Patch Changes

- [`2891046`](https://github.com/Effectful-Tech/clanka/commit/28910469548cded1fd85aa790bf67ae032052f93) Thanks [@tim-smart](https://github.com/tim-smart)! - add replay to output broadcast

## 0.1.0

### Minor Changes

- [`8e1d893`](https://github.com/Effectful-Tech/clanka/commit/8e1d893f785562fb2ff894176cb3dc3f130e3937) Thanks [@tim-smart](https://github.com/tim-smart)! - Seperate executor completely from agent

## 0.0.29

### Patch Changes

- [#55](https://github.com/Effectful-Tech/clanka/pull/55) [`37f007c`](https://github.com/Effectful-Tech/clanka/commit/37f007c79a6b30ae528f11455a9c1aa00e57a4b7) Thanks [@tim-smart](https://github.com/tim-smart)! - Add a brief inline comment next to `declare const fetch` in both system prompt variants to clarify that it exposes the global Fetch API for HTTP requests.

- [#53](https://github.com/Effectful-Tech/clanka/pull/53) [`88d72fa`](https://github.com/Effectful-Tech/clanka/commit/88d72fa6945833cbd017a22c5869123f52bbfe6b) Thanks [@tim-smart](https://github.com/tim-smart)! - Use `HttpClient.followRedirects()` in `WebToMarkdown` so redirected URLs are fetched successfully before markdown conversion. Added a regression test covering a 302 redirect flow in `WebToMarkdown.convertUrl`.

## 0.0.28

### Patch Changes

- [`d10f450`](https://github.com/Effectful-Tech/clanka/commit/d10f4509c2f8e58795c2210512751f3a05e10f95) Thanks [@tim-smart](https://github.com/tim-smart)! - fix toolkit types

## 0.0.27

### Patch Changes

- [`b388c8f`](https://github.com/tim-smart/clanka/commit/b388c8f9b9b1d712fca974b28d04c16291e3d617) Thanks [@tim-smart](https://github.com/tim-smart)! - add web search

- [#51](https://github.com/tim-smart/clanka/pull/51) [`23fa4b4`](https://github.com/tim-smart/clanka/commit/23fa4b49d98c6a4c0a76194ecbe3a26f6be9fa48) Thanks [@tim-smart](https://github.com/tim-smart)! - Allow wrapped applyPatch inputs to succeed when `*** End Patch` is missing at EOF.

## 0.0.26

### Patch Changes

- [`bdf196f`](https://github.com/tim-smart/clanka/commit/bdf196f2671c122874743b816c81ff721c20c39c) Thanks [@tim-smart](https://github.com/tim-smart)! - use -uu for rg no ignore

## 0.0.25

### Patch Changes

- [`589c2cb`](https://github.com/tim-smart/clanka/commit/589c2cbb18d079e7e67ef2b7fc209382fa69e464) Thanks [@tim-smart](https://github.com/tim-smart)! - try avoid nested delegation

## 0.0.24

### Patch Changes

- [`f1e8aa0`](https://github.com/tim-smart/clanka/commit/f1e8aa0d8c8c4b9c80ffb2bd61658617f0681902) Thanks [@tim-smart](https://github.com/tim-smart)! - enable noIgnore when glob is set

## 0.0.23

### Patch Changes

- [`3ec9faf`](https://github.com/tim-smart/clanka/commit/3ec9faf257e7e6ffa304037cd52827ad118aec76) Thanks [@tim-smart](https://github.com/tim-smart)! - allow writing existing files

- [#46](https://github.com/tim-smart/clanka/pull/46) [`be02802`](https://github.com/tim-smart/clanka/commit/be02802915a08377b5f6aeb2dba0696f51564fc4) Thanks [@tim-smart](https://github.com/tim-smart)! - Forward nested subagent events so delegated grandchildren show their start, progress, and completion output.

## 0.0.22

### Patch Changes

- [#42](https://github.com/tim-smart/clanka/pull/42) [`c61f6ed`](https://github.com/tim-smart/clanka/commit/c61f6ed9a4dd20c05382dbb7ec5b9bbca93e6994) Thanks [@tim-smart](https://github.com/tim-smart)! - Support both git/unified diff patches and wrapped apply_patch patches in the public applyPatch tool interface.

- [#42](https://github.com/tim-smart/clanka/pull/42) [`c61f6ed`](https://github.com/tim-smart/clanka/commit/c61f6ed9a4dd20c05382dbb7ec5b9bbca93e6994) Thanks [@tim-smart](https://github.com/tim-smart)! - Improve applyPatch test coverage with larger realistic multi-file git diff cases, context disambiguation, and atomic failure assertions.

- [#44](https://github.com/tim-smart/clanka/pull/44) [`8ad737d`](https://github.com/tim-smart/clanka/commit/8ad737d6fb380f0434a00324a2248a4ca19bac9c) Thanks [@tim-smart](https://github.com/tim-smart)! - Add a noIgnore option to the rg tool so ripgrep searches can include ignored files when requested.

## 0.0.21

### Patch Changes

- [`eee5638`](https://github.com/tim-smart/clanka/commit/eee5638b6bcf3ff4cee6dd273c0be983977534f1) Thanks [@tim-smart](https://github.com/tim-smart)! - tweak system

## 0.0.20

### Patch Changes

- [`5f76244`](https://github.com/tim-smart/clanka/commit/5f76244c6af8a560cd3335345af6c1457a0ebd5c) Thanks [@tim-smart](https://github.com/tim-smart)! - fix buffering and muxing

## 0.0.19

### Patch Changes

- [`983114f`](https://github.com/tim-smart/clanka/commit/983114f2fd7a0f8c4e7a4a78971fa6708d64460a) Thanks [@tim-smart](https://github.com/tim-smart)! - only require output stream for Muxer

## 0.0.18

### Patch Changes

- [`77efdd3`](https://github.com/tim-smart/clanka/commit/77efdd3179a6e90fb77e9ed93dde0eee62466bfb) Thanks [@tim-smart](https://github.com/tim-smart)! - add OutputFormatter.Muxer

## 0.0.17

### Patch Changes

- [`7f78db3`](https://github.com/tim-smart/clanka/commit/7f78db36a12294a234ddc72eab0fdcc1c75f808f) Thanks [@tim-smart](https://github.com/tim-smart)! - tweak tool prompt

## 0.0.16

### Patch Changes

- [`5ddd1cc`](https://github.com/tim-smart/clanka/commit/5ddd1cc1e7d9b19fe1fc67c57f1783b53b0f6326) Thanks [@tim-smart](https://github.com/tim-smart)! - rename createFile to writeFile

- [#35](https://github.com/tim-smart/clanka/pull/35) [`208f169`](https://github.com/tim-smart/clanka/commit/208f169cf60a3db5675959aba83ea80c2e6bc36c) Thanks [@tim-smart](https://github.com/tim-smart)! - Refactor applyPatch to accept git diff / unified diff input, including multi-file add, delete, and rename patches while preserving raw hunk support for single-file content transforms.

## 0.0.15

### Patch Changes

- [`42dd340`](https://github.com/tim-smart/clanka/commit/42dd3405c6e305d7d4d2a79171ac6a7127241cff) Thanks [@tim-smart](https://github.com/tim-smart)! - fix output locking

- [`d49cb7d`](https://github.com/tim-smart/clanka/commit/d49cb7d65c7656d2d65cee41d71190af3925fb2d) Thanks [@tim-smart](https://github.com/tim-smart)! - system tweaks

## 0.0.14

### Patch Changes

- [`1435087`](https://github.com/tim-smart/clanka/commit/143508729e23a4188cd4747b8949746750cf6b8a) Thanks [@tim-smart](https://github.com/tim-smart)! - prompt tweaks

## 0.0.13

### Patch Changes

- [`c4e3cb9`](https://github.com/tim-smart/clanka/commit/c4e3cb95c05bedbe361c41e25ce4447b4c7f71d6) Thanks [@tim-smart](https://github.com/tim-smart)! - revert

## 0.0.12

### Patch Changes

- [`f19901c`](https://github.com/tim-smart/clanka/commit/f19901c46895eaa21ca53c818188d945c941430a) Thanks [@tim-smart](https://github.com/tim-smart)! - dont fail promises due to interruption

## 0.0.11

### Patch Changes

- [`b0baf26`](https://github.com/tim-smart/clanka/commit/b0baf26f1cd53ffa0812dde8998a74f2d0cf613b) Thanks [@tim-smart](https://github.com/tim-smart)! - fix ScriptEnd not reset output lock

## 0.0.10

### Patch Changes

- [`f089121`](https://github.com/tim-smart/clanka/commit/f0891218366dcbb08d3554038c09ff96ff09592f) Thanks [@tim-smart](https://github.com/tim-smart)! - subagent/delegate/g

## 0.0.9

### Patch Changes

- [`1d2c46f`](https://github.com/tim-smart/clanka/commit/1d2c46f31c2e1f9355c1237899edebef2c960c04) Thanks [@tim-smart](https://github.com/tim-smart)! - fix singleToolMode detection

## 0.0.8

### Patch Changes

- [`67a789f`](https://github.com/tim-smart/clanka/commit/67a789fdf0471110c8171462e26969d12aec88c7) Thanks [@tim-smart](https://github.com/tim-smart)! - fix requirements

## 0.0.7

### Patch Changes

- [`eb56541`](https://github.com/tim-smart/clanka/commit/eb56541bd5686829095616b874e188d180511fc3) Thanks [@tim-smart](https://github.com/tim-smart)! - relax OutputFormatter

## 0.0.6

### Patch Changes

- [`d539084`](https://github.com/tim-smart/clanka/commit/d53908400b8d9541c3e48e342f9b40b6db66c22e) Thanks [@tim-smart](https://github.com/tim-smart)! - better handle void params

## 0.0.5

### Patch Changes

- [`ef011ca`](https://github.com/tim-smart/clanka/commit/ef011ca73f5a5d3ef1721a05db7278b9d50abd6c) Thanks [@tim-smart](https://github.com/tim-smart)! - support tool mode for models that don't work with plain js

- [`a1a9699`](https://github.com/tim-smart/clanka/commit/a1a96999e94a6f1a868ebd75766e25c4f382026e) Thanks [@tim-smart](https://github.com/tim-smart)! - Add a GitHub Copilot provider layer backed by the device auth flow and the Copilot OpenAI-compatible API.

  Implement `ScriptExtraction.extractScript` to extract fenced code blocks from markdown responses.

## 0.0.4

### Patch Changes

- [`5875e31`](https://github.com/tim-smart/clanka/commit/5875e31c6b6b70a2ebcb5867510d98ac46c4a4a8) Thanks [@tim-smart](https://github.com/tim-smart)! - refactor subagent output into a schema-wrapped part and flatten nested subagent streams

- [`ef78aa2`](https://github.com/tim-smart/clanka/commit/ef78aa2482e36f73838a5a3857fa7fb06b11a2c3) Thanks [@tim-smart](https://github.com/tim-smart)! - use assistant role for script output

- [`748376f`](https://github.com/tim-smart/clanka/commit/748376ffe0596a4d340562412550d1eda8432c46) Thanks [@tim-smart](https://github.com/tim-smart)! - add Agent.steer

## 0.0.3

### Patch Changes

- [`1a5553d`](https://github.com/tim-smart/clanka/commit/1a5553d9b08aa5a3dc0728789d1b4a8358741e82) Thanks [@tim-smart](https://github.com/tim-smart)! - let subagent know it is a subagent

## 0.0.2

### Patch Changes

- improvements

## 0.0.1

### Patch Changes

- initial

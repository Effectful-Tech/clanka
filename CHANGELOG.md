# clanka

## 0.2.48

### Patch Changes

- [`652709e`](https://github.com/Effectful-Tech/clanka/commit/652709e24dae66135adc439942814ef610d4576b) Thanks [@tim-smart](https://github.com/tim-smart)! - Fix script preprocessing to follow assignment root identifiers so template literals are escaped even when a writeFile content value is derived from another variable (e.g. `content = spec.replaceAll(...)`). This resolves the failing patch20 preprocessing fixture.

## 0.2.47

### Patch Changes

- [`dccd219`](https://github.com/Effectful-Tech/clanka/commit/dccd219bde0eb51b847f81c4ab4af6e8b1a7af2f) Thanks [@tim-smart](https://github.com/tim-smart)! - update effect

## 0.2.46

### Patch Changes

- [`33beb46`](https://github.com/Effectful-Tech/clanka/commit/33beb4686a87845c1f3bc99c2fcd9e0a2bf77e57) Thanks [@tim-smart](https://github.com/tim-smart)! - update effect

- [`037b522`](https://github.com/Effectful-Tech/clanka/commit/037b522c7d1b8371c463fcf8dae7823ded2384c5) Thanks [@tim-smart](https://github.com/tim-smart)! - increase turn timeout to 5 minute

## 0.2.45

### Patch Changes

- [`9c78557`](https://github.com/Effectful-Tech/clanka/commit/9c78557e92c19f84d4ceddb1d7087ddd0ea3b31d) Thanks [@tim-smart](https://github.com/tim-smart)! - don't send partial responses back

## 0.2.44

### Patch Changes

- [`764be7b`](https://github.com/Effectful-Tech/clanka/commit/764be7bed9ed20bd7a611fc81777ec1c85175dbf) Thanks [@tim-smart](https://github.com/tim-smart)! - tweak turn timeout to append response

## 0.2.43

### Patch Changes

- [`10f7003`](https://github.com/Effectful-Tech/clanka/commit/10f7003e2dc8201a3d9a427b7f3d3a3246e15662) Thanks [@tim-smart](https://github.com/tim-smart)! - Fix script preprocessing for patch templates so doubly-escaped markdown code-span backticks are normalized without breaking valid escaped backticks inside code snippets.

## 0.2.42

### Patch Changes

- [`013f30d`](https://github.com/Effectful-Tech/clanka/commit/013f30d310c2e26c6a849ade9e6a5d7d09b8917f) Thanks [@tim-smart](https://github.com/tim-smart)! - bring back TurnTimeout

## 0.2.41

### Patch Changes

- [`e7a4178`](https://github.com/Effectful-Tech/clanka/commit/e7a4178b80de0baf1273153898606bcc9857e257) Thanks [@tim-smart](https://github.com/tim-smart)! - fix script preprocessing for String.raw tagged template literals so broken markdown code fences are escaped correctly

## 0.2.40

### Patch Changes

- [`1bc2ba3`](https://github.com/Effectful-Tech/clanka/commit/1bc2ba33ff33da0459e5620538789b53b870f8e1) Thanks [@tim-smart](https://github.com/tim-smart)! - remove TurnTimeout

## 0.2.39

### Patch Changes

- [`edaf4fb`](https://github.com/Effectful-Tech/clanka/commit/edaf4fb6f54dec10b3432d2389973833c0e4f1f8) Thanks [@tim-smart](https://github.com/tim-smart)! - claude can be dumb

## 0.2.38

### Patch Changes

- [`e195284`](https://github.com/Effectful-Tech/clanka/commit/e1952847fcb30092f033c5db6fd1288887a65d20) Thanks [@tim-smart](https://github.com/tim-smart)! - simplify prompt

## 0.2.37

### Patch Changes

- [`f8aeea2`](https://github.com/Effectful-Tech/clanka/commit/f8aeea2f77975b8585ae88ab26114e512d2442fb) Thanks [@tim-smart](https://github.com/tim-smart)! - add TurnTimeout reference

## 0.2.36

### Patch Changes

- [`50143fb`](https://github.com/Effectful-Tech/clanka/commit/50143fb24bd17bb9f135b80361d16b6dff88cd5e) Thanks [@tim-smart](https://github.com/tim-smart)! - Fix script preprocessing for nested applyPatch template literals without changing fixture inputs.

## 0.2.35

### Patch Changes

- [`825e376`](https://github.com/Effectful-Tech/clanka/commit/825e37619738f5ce64b62efcd8d75639400ca50a) Thanks [@tim-smart](https://github.com/tim-smart)! - Fix script preprocessing so applyPatch templates keep repeated control-escape strings stable while still escaping broken nested template content.

## 0.2.34

### Patch Changes

- [`e73b9b2`](https://github.com/Effectful-Tech/clanka/commit/e73b9b2b97caccac268372ef8e9782c5fc996201) Thanks [@tim-smart](https://github.com/tim-smart)! - update effect

## 0.2.33

### Patch Changes

- [`dcf255d`](https://github.com/Effectful-Tech/clanka/commit/dcf255dc2710ef79480c238c27083726d6be0d96) Thanks [@tim-smart](https://github.com/tim-smart)! - update prompt

- [`11e5871`](https://github.com/Effectful-Tech/clanka/commit/11e58714a379442f5d5d71362a0910e8bf42598e) Thanks [@tim-smart](https://github.com/tim-smart)! - Fix script preprocessing for applyPatch templates that intentionally preserve literal template markers via string-based interpolations.

## 0.2.32

### Patch Changes

- [`eb419e1`](https://github.com/Effectful-Tech/clanka/commit/eb419e1285885f9f69b644cfe6927a2414b89fe0) Thanks [@tim-smart](https://github.com/tim-smart)! - prompt tweaks

## 0.2.31

### Patch Changes

- [`ab19e49`](https://github.com/Effectful-Tech/clanka/commit/ab19e4995516b2ef6088f0662870328137eb0dc5) Thanks [@tim-smart](https://github.com/tim-smart)! - update effect

- [`7da73ae`](https://github.com/Effectful-Tech/clanka/commit/7da73ae0464a908ba89f53b5f1bb15eae3b9febc) Thanks [@tim-smart](https://github.com/tim-smart)! - prompt tweaks

## 0.2.30

### Patch Changes

- [`d7f700f`](https://github.com/Effectful-Tech/clanka/commit/d7f700f446ec355fd972afd1792c293e5a3ae087) Thanks [@tim-smart](https://github.com/tim-smart)! - expose history ref

- [`7286392`](https://github.com/Effectful-Tech/clanka/commit/7286392f9e149b2d01ea78b5df578cee28203eb2) Thanks [@tim-smart](https://github.com/tim-smart)! - add todo list

## 0.2.29

### Patch Changes

- [`761957b`](https://github.com/Effectful-Tech/clanka/commit/761957b0335a9a6feec12b50a0b7c4a5a789c2a7) Thanks [@tim-smart](https://github.com/tim-smart)! - Fix script preprocessing for applyPatch templates that include nested template literals in patch content.

- [`82a0dfc`](https://github.com/Effectful-Tech/clanka/commit/82a0dfcc17cb2dc993d02b24c1eeeb4d162834fb) Thanks [@tim-smart](https://github.com/tim-smart)! - Fix script preprocessing so applyPatch template content keeps already-escaped template markers while still escaping unescaped backticks.

- [`d88f7f3`](https://github.com/Effectful-Tech/clanka/commit/d88f7f3add98954685fb25e94a4dccaa9e75c107) Thanks [@tim-smart](https://github.com/tim-smart)! - Rewrite ScriptPreprocessing with a clearer target-scanning pipeline while preserving template escaping behavior.

## 0.2.28

### Patch Changes

- [`bbefa4a`](https://github.com/Effectful-Tech/clanka/commit/bbefa4a2c67f7db2a500d80e130a4c1c18ab705c) Thanks [@tim-smart](https://github.com/tim-smart)! - don't use reasoning parts in conversation final summary

## 0.2.27

### Patch Changes

- [`383a372`](https://github.com/Effectful-Tech/clanka/commit/383a3723706b9d401a02e1d57e6090d6009091b5) Thanks [@tim-smart](https://github.com/tim-smart)! - remove taskComplete from system prompt in conversation mode

- [`b27fa5a`](https://github.com/Effectful-Tech/clanka/commit/b27fa5a7c89f9f01a1f2224f86eef72aa1ccffe1) Thanks [@tim-smart](https://github.com/tim-smart)! - allow customizing search database directory

## 0.2.26

### Patch Changes

- [`ae342db`](https://github.com/Effectful-Tech/clanka/commit/ae342dbc3999503bbfad6b084021a942f6a61068) Thanks [@tim-smart](https://github.com/tim-smart)! - Add an Agent conversation mode flag that exits when a reply completes without tool calls, while still honoring taskComplete.

## 0.2.25

### Patch Changes

- [`5fbb010`](https://github.com/Effectful-Tech/clanka/commit/5fbb01010f0ff52a7e47f2553ca1a19d6a1a74b7) Thanks [@tim-smart](https://github.com/tim-smart)! - decrease embedding batch size

## 0.2.24

### Patch Changes

- [`ae14234`](https://github.com/Effectful-Tech/clanka/commit/ae1423485147bb4c6e4dfc8a3796acd8697be37e) Thanks [@tim-smart](https://github.com/tim-smart)! - move some deps for cli

- [`52fdb10`](https://github.com/Effectful-Tech/clanka/commit/52fdb10efc5128dd5fa8cffb3a5fcf5e21c7d41b) Thanks [@tim-smart](https://github.com/tim-smart)! - don't import SemanticSearch impl unless needed

## 0.2.23

### Patch Changes

- [`d205b45`](https://github.com/Effectful-Tech/clanka/commit/d205b45d8cb8dbbb83b793bf06d232ef8921a713) Thanks [@tim-smart](https://github.com/tim-smart)! - fix duplicate flag

## 0.2.22

### Patch Changes

- [`ceb557d`](https://github.com/Effectful-Tech/clanka/commit/ceb557df00c45167cf57f877a0488e721342139b) Thanks [@tim-smart](https://github.com/tim-smart)! - more cli options

## 0.2.21

### Patch Changes

- [`cc55066`](https://github.com/Effectful-Tech/clanka/commit/cc550665fd8520273538166618cd65bc1f879624) Thanks [@tim-smart](https://github.com/tim-smart)! - fix script preprocessing for writeFile content sourced from Object.entries maps by normalizing over-escaped template markers in assigned objects

## 0.2.20

### Patch Changes

- [`573f88a`](https://github.com/Effectful-Tech/clanka/commit/573f88a9cf2c40e7caf54049a16b4df50b9ca32d) Thanks [@tim-smart](https://github.com/tim-smart)! - update effect

- [#112](https://github.com/Effectful-Tech/clanka/pull/112) [`fee2a1c`](https://github.com/Effectful-Tech/clanka/commit/fee2a1c517e172f960b3d6f35003dc4444bbdee2) Thanks [@tim-smart](https://github.com/tim-smart)! - Add character-based chunk size limits to CodeChunker with overlap-preserving splitting, and allow SemanticSearch chunking to configure chunkMaxCharacters (default 30,000).

- [`8eef33e`](https://github.com/Effectful-Tech/clanka/commit/8eef33e253bb33647b78e793a26baef90c95f308) Thanks [@tim-smart](https://github.com/tim-smart)! - add note about applyPatch

## 0.2.19

### Patch Changes

- [`7fb8e3b`](https://github.com/Effectful-Tech/clanka/commit/7fb8e3b59d188cf160d7224f2c2d2aea969cd8b5) Thanks [@tim-smart](https://github.com/tim-smart)! - Fix script preprocessing for non-patch template literals that contain doubly escaped markdown markers (for example, \\`code\\`). These are now normalized to single escaped markers before preprocessing so task summaries remain stable and valid. Also fix assigned template detection to correctly handle multiline patch literals that close at end-of-line, ensuring trailing backticks inside patch content are escaped.

## 0.2.18

### Patch Changes

- [`d6f06e3`](https://github.com/Effectful-Tech/clanka/commit/d6f06e35c2757778f86a4004d11cad323e1e2f7a) Thanks [@tim-smart](https://github.com/tim-smart)! - Fix script preprocessing for task update descriptions by escaping broken backticks in `updateTask` `description` templates (including identifier assignments), while preserving existing non-patch escapes.

## 0.2.17

### Patch Changes

- [`279e496`](https://github.com/Effectful-Tech/clanka/commit/279e4967b20b0197f075b17ab90a3c7b38265fa2) Thanks [@tim-smart](https://github.com/tim-smart)! - Fix script preprocessing for broken patch templates by handling standalone `patch` assignments and normalizing over-escaped quoted words inside patch bodies before escaping template delimiters.

- [`8f43842`](https://github.com/Effectful-Tech/clanka/commit/8f43842d37316e960d5f1d4ff3a520d65e0b213b) Thanks [@tim-smart](https://github.com/tim-smart)! - update applyPatch description

## 0.2.16

### Patch Changes

- [`cefdea3`](https://github.com/Effectful-Tech/clanka/commit/cefdea32ee97f87ec66acd83120a015e3ddf69c2) Thanks [@tim-smart](https://github.com/tim-smart)! - Fix script preprocessing for tool-call templates by selecting the last matching template delimiter instead of the first. This prevents premature termination when writeFile content contains markdown inline code spans with commas, and correctly escapes all internal backticks.

## 0.2.15

### Patch Changes

- [`361800e`](https://github.com/Effectful-Tech/clanka/commit/361800eb3c2612bb873f9c80661465f50fbd03f2) Thanks [@tim-smart](https://github.com/tim-smart)! - Fix script preprocessing for tool-call template arguments by locating the template end from the call boundary instead of the first `)`-adjacent backtick. This prevents partial escaping when markdown inline code inside `taskComplete` or `applyPatch` contains patterns like ``code`),`.

## 0.2.14

### Patch Changes

- [`25368c9`](https://github.com/Effectful-Tech/clanka/commit/25368c95e2c4098ffa9c577168e4a6fbde98f012) Thanks [@tim-smart](https://github.com/tim-smart)! - Add TypeScript namespace support to CodeChunker AST chunking, including namespace declarations and nested members.

## 0.2.13

### Patch Changes

- [`6666be6`](https://github.com/Effectful-Tech/clanka/commit/6666be6a0e70f7486418af4c8befaf77ba5f3203) Thanks [@tim-smart](https://github.com/tim-smart)! - batch existence checks

## 0.2.12

### Patch Changes

- [`85f5bb9`](https://github.com/Effectful-Tech/clanka/commit/85f5bb9a1308490ad98ab2eeeb8dd089d272c3f4) Thanks [@tim-smart](https://github.com/tim-smart)! - simpilify search api

## 0.2.11

### Patch Changes

- [`bd4568f`](https://github.com/Effectful-Tech/clanka/commit/bd4568fd04d3f453b44fd359790ade4a41cf7a67) Thanks [@tim-smart](https://github.com/tim-smart)! - allow configuring output truncation in pretty formatter

- [#101](https://github.com/Effectful-Tech/clanka/pull/101) [`78d1e07`](https://github.com/Effectful-Tech/clanka/commit/78d1e0774e11564284c9eeb64bbad7b95f1fb404) Thanks [@tim-smart](https://github.com/tim-smart)! - add script pre-processing fallback that escapes unescaped backticks in applyPatch, writeFile, and taskComplete template arguments before execution

## 0.2.10

### Patch Changes

- [`b1f690a`](https://github.com/Effectful-Tech/clanka/commit/b1f690addf7183876528d1971684aaa4fc00ea86) Thanks [@tim-smart](https://github.com/tim-smart)! - align tree sitter versions

## 0.2.9

### Patch Changes

- [`44a2da6`](https://github.com/Effectful-Tech/clanka/commit/44a2da695d57075c075c2aec6c2181c362d40ff2) Thanks [@tim-smart](https://github.com/tim-smart)! - downgrade tree sitter

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

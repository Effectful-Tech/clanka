# clanka

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

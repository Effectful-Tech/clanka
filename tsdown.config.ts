import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/cli.ts"],
  outDir: "dist/bin",
  platform: "node",
  format: "esm",
  sourcemap: true,
  dts: false,
  // V8 keeps the bundle source resident for the life of the process. Strip
  // comments to shrink it, and escape non-ASCII characters so V8 can store
  // it as a one-byte string instead of UTF-16 (which doubles its size).
  // License comments are kept.
  minify: {
    compress: false,
    mangle: false,
    codegen: { removeWhitespace: false, asciiOnly: true },
  },
  outputOptions: {
    comments: { legal: true, annotation: false, jsdoc: false },
  },
  deps: {
    // Bundle dependencies too, so unused Effect schemas and modules are removed.
    alwaysBundle: /.*/,
    onlyBundle: false,
    neverBundle: [
      // These packages locate native binaries or WASM relative to their own files.
      "tree-sitter",
      "tree-sitter-javascript",
      "tree-sitter-typescript",
      "sqlite-vec",
      "@silvia-odwyer/photon-node",
      "@vscode/ripgrep",
    ],
  },
})

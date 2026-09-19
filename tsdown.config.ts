import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/cli.ts"],
  outDir: "dist/bin",
  platform: "node",
  format: "esm",
  sourcemap: true,
  dts: false,
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
      // Preserve the CommonJS named exports used by platform-node.
      "undici",
      "ws",
    ],
  },
})

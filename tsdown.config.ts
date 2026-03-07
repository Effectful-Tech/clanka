import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  outDir: "dist",
  treeshake: true,
  inlineOnly: false,
})

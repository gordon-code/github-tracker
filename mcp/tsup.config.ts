import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node22",
  bundle: true,
  clean: true,
  external: ["@modelcontextprotocol/sdk", "ws", "zod"],
  banner: { js: "#!/usr/bin/env node" },
});

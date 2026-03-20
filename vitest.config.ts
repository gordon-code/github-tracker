import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

// Separate Vitest config that excludes the @cloudflare/vite-plugin.
// The cloudflare plugin conflicts with Vitest's test runner environment.
// vite.config.ts (with the cloudflare plugin) is used only for builds.
export default defineConfig({
  plugins: [solid(), tailwindcss()],
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["tests/worker/**"],
    passWithNoTests: true,
  },
});

import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

// Separate Vitest config that excludes the @cloudflare/vite-plugin.
// The cloudflare plugin conflicts with Vitest's test runner environment.
// vite.config.ts (with the cloudflare plugin) is used only for builds.
export default defineConfig({
  plugins: [solid(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify("0.1.0-test"),
    __GIT_SHA__: JSON.stringify("abcdef123456"),
    __BUILD_TIME__: JSON.stringify("2026-01-01T00:00:00.000Z"),
  },
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["tests/worker/**"],
    passWithNoTests: true,
  },
});

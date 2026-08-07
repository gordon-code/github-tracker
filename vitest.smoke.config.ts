import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

// Standalone config for live-network smoke tests (e.g. github-status.smoke.test.ts).
// These are deliberately excluded from vitest.workspace.ts's "browser" project
// (see its `exclude: [..., "tests/**/*.smoke.test.ts"]`) so `pnpm test` never hits
// the network — vitest.workspace.ts's exclude takes precedence over a CLI file
// filter, so re-including the same file via `vitest run <path>` against that
// config is not possible. Run smoke tests explicitly via `pnpm test:status-smoke`.
export default defineConfig({
  plugins: [solid(), tailwindcss()],
  test: {
    name: "status-smoke",
    environment: "happy-dom",
    globals: true,
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.smoke.test.ts"],
  },
});

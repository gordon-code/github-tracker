import { defineConfig, mergeConfig, type UserConfig } from "vitest/config";
import baseConfig from "./vitest.config";

// Standalone config for live-network smoke tests (e.g. github-status.smoke.test.ts).
// These are deliberately excluded from vitest.workspace.ts's "browser" project
// (see its `exclude: [..., "tests/**/*.smoke.test.ts"]`) so `pnpm test` never hits
// the network — vitest.workspace.ts's exclude takes precedence over a CLI file
// filter, so re-including the same file via `vitest run <path>` against that
// config is not possible. Run smoke tests explicitly via `pnpm test:status-smoke`.
//
// Extends the root vitest.config.ts to inherit plugins/environment/globals/
// setupFiles instead of duplicating them. `include` is assigned directly on
// the merged result rather than passed into mergeConfig: Vite's mergeConfig
// concatenates array values instead of replacing them, so merging an
// `include` override here would append to vitest.config.ts's patterns
// instead of overriding them, and this config would start running the
// regular unit test suite too.
const merged = mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "status-smoke",
    },
  }),
) as UserConfig;
merged.test = { ...merged.test, include: ["tests/**/*.smoke.test.ts"] };

export default merged;

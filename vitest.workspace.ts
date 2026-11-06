import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, defineProject } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    projects: [
      // MCP server tests (Node.js environment)
      "mcp/vitest.config.ts",
      // Browser/DOM tests (stores, services, UI)
      defineProject({
        plugins: [solid(), tailwindcss()],
        resolve: {
          alias: {
            "virtual:changelog": resolve(rootDir, "tests/stubs/virtual-changelog.ts"),
          },
        },
        define: {
          __APP_VERSION__: JSON.stringify("0.1.0"),
          __GIT_SHA__: JSON.stringify("abcdef123456"),
          __BUILD_TIME__: JSON.stringify("2026-01-01T00:00:00.000Z"),
        },
        test: {
          name: "browser",
          environment: "happy-dom",
          globals: true,
          hookTimeout: 30_000,
          // fetch-guard.ts is browser-project-only (not in tests/setup.ts) so the
          // live-network smoke suite, which shares tests/setup.ts, stays unguarded.
          setupFiles: ["tests/setup.ts", "tests/fetch-guard.ts"],
          include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "tests/**/*.steps.tsx"],
          exclude: ["tests/worker/**", "tests/**/*.smoke.test.ts"],
        },
      }),
      // Cloudflare Worker tests
      defineProject({
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.toml" },
          }),
        ],
        test: {
          name: "worker",
          globals: true,
          setupFiles: ["tests/worker/setup.ts"],
          include: ["tests/worker/**/*.test.ts"],
        },
      }),
    ],
  },
});

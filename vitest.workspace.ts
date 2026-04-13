import { defineConfig, defineProject } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  test: {
    projects: [
      // MCP server tests (Node.js environment)
      "mcp/vitest.config.ts",
      // Browser/DOM tests (stores, services, UI)
      defineProject({
        plugins: [solid(), tailwindcss()],
        test: {
          name: "browser",
          environment: "happy-dom",
          globals: true,
          hookTimeout: 30_000,
          setupFiles: ["tests/setup.ts"],
          include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "tests/**/*.steps.tsx"],
          exclude: ["tests/worker/**"],
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

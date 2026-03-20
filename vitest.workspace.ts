import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    // Browser/DOM tests (stores, services, UI)
    test: {
      name: "browser",
      environment: "happy-dom",
      globals: true,
      include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
      exclude: ["tests/worker/**"],
    },
  },
  {
    // Cloudflare Worker tests
    test: {
      name: "worker",
      include: ["tests/worker/**/*.test.ts"],
      pool: "@cloudflare/vitest-pool-workers",
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.toml" },
        },
      },
    },
  },
]);

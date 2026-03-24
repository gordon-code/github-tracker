import { defineConfig, defineProject } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  test: {
    projects: [
      // Browser/DOM tests (stores, services, UI)
      defineProject({
        plugins: [solid(), tailwindcss()],
        test: {
          name: "browser",
          environment: "happy-dom",
          globals: true,
          setupFiles: ["tests/setup.ts"],
          include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
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
          include: ["tests/worker/**/*.test.ts"],
        },
      }),
    ],
  },
});

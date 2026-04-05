import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT) || 5173;

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["**/capture-screenshot.spec.ts"],
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  webServer: {
    command: `pnpm exec vite dev --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});

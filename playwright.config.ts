import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT) || 5173;

export default defineConfig({
  testDir: "./e2e",
  reporter: [["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  webServer: {
    command: `pnpm exec vite dev --port ${port}`,
    url: `http://localhost:${port}`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});

import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT) || 5173;

// The default run is Chromium-only (system Chrome). `CROSS_BROWSER=1` adds Firefox and WebKit
// projects that run only the tests tagged `@cross-browser`; they use Playwright's own browser
// builds, so they need `playwright install firefox webkit` first (see `pnpm test:e2e:cross-browser`).
const crossBrowser = process.env.CROSS_BROWSER === "1";

export default defineConfig({
  testDir: "./e2e",
  testIgnore: ["**/capture-screenshot.spec.ts"],
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
    ...(crossBrowser
      ? [
          { name: "firefox", use: { ...devices["Desktop Firefox"] }, grep: /@cross-browser/ },
          { name: "webkit", use: { ...devices["Desktop Safari"] }, grep: /@cross-browser/ },
        ]
      : []),
  ],
  webServer: {
    command: `pnpm exec vite dev --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});

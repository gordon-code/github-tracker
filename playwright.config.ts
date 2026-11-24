import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT) || 5173;
// Not 4173 (the default `pnpm preview` port), so a direct `playwright test` does not collide
// with a preview the developer already has running.
const previewPort = Number(process.env.E2E_PREVIEW_PORT) || 4317;

// The default run is Chromium-only (system Chrome). `CROSS_BROWSER=1` adds Firefox and WebKit
// projects that run only the tests tagged `@cross-browser`; they use Playwright's own browser
// builds, so they need `playwright install firefox webkit` first (see `pnpm test:e2e:cross-browser`).
const crossBrowser = process.env.CROSS_BROWSER === "1";

// Specs named `*.preview.spec.ts` exercise Vite's production preload helper (hashed chunks under
// /_app/ and the `vite:preloadError` event), which `vite dev` does not have, so they run in the
// `chromium-preview` project against `pnpm build && vite preview` (the built Worker serving dist/).
// Playwright starts every web server whatever `--project` selects, so `E2E_SERVERS=preview`
// (`pnpm test:e2e:preview`) runs only that project and server, and `E2E_SERVERS=dev` skips the
// production build and preview server.
const PREVIEW_SPECS = "**/*.preview.spec.ts";
const servers = process.env.E2E_SERVERS;
const withPreview = !crossBrowser && servers !== "dev";
const withDev = servers !== "preview";
// A project's own `testIgnore` replaces the top-level one, so every project lists this.
const SCREENSHOT_SPEC = "**/capture-screenshot.spec.ts";

export default defineConfig({
  testDir: "./e2e",
  testIgnore: [SCREENSHOT_SPEC],
  reporter: [["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "on-first-retry",
  },
  projects: [
    ...(withDev
      ? [
          {
            name: "chromium",
            testIgnore: [SCREENSHOT_SPEC, PREVIEW_SPECS],
            use: { ...devices["Desktop Chrome"], channel: "chrome" },
          },
        ]
      : []),
    ...(crossBrowser && withDev
      ? [
          { name: "firefox", testIgnore: [SCREENSHOT_SPEC, PREVIEW_SPECS], use: { ...devices["Desktop Firefox"] }, grep: /@cross-browser/ },
          { name: "webkit", testIgnore: [SCREENSHOT_SPEC, PREVIEW_SPECS], use: { ...devices["Desktop Safari"] }, grep: /@cross-browser/ },
        ]
      : []),
    ...(withPreview
      ? [
          {
            name: "chromium-preview",
            testMatch: PREVIEW_SPECS,
            use: {
              ...devices["Desktop Chrome"],
              channel: "chrome",
              baseURL: `http://localhost:${previewPort}`,
            },
          },
        ]
      : []),
  ],
  webServer: [
    ...(withDev
      ? [
          {
            command: `pnpm exec vite dev --port ${port} --strictPort`,
            url: `http://localhost:${port}`,
            timeout: 120_000,
            reuseExistingServer: !process.env.CI,
          },
        ]
      : []),
    ...(withPreview
      ? [
          {
            command: `pnpm build && pnpm exec vite preview --port ${previewPort} --strictPort`,
            url: `http://localhost:${previewPort}`,
            timeout: 180_000,
            // Never attach to an already-running preview: it would serve an older dist/.
            reuseExistingServer: false,
          },
        ]
      : []),
  ],
});

import { test, expect } from "@playwright/test";
import { resolveGitSha } from "../vite-plugins/build-meta";
import { setupAuth } from "./helpers";

const currentSha = resolveGitSha();
const differentSha =
  currentSha === "111111111111" ? "222222222222" : "111111111111";

test("shows update banner when version.json reports a new SHA and triggers full reload on navigation", async ({
  page,
}) => {
  await setupAuth(page);
  await page.route("**/version.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: "9.9.9",
        sha: differentSha,
        builtAt: "2026-01-02T00:00:00.000Z",
      }),
    }),
  );

  await page.goto("/dashboard");

  const banner = page
    .getByRole("status")
    .filter({ hasText: "A new version is available." });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(banner.getByRole("link", { name: "Changelog" })).toBeVisible();

  const loadPromise = page.waitForEvent("load");
  await page.getByRole("link", { name: "Settings" }).click();
  await loadPromise;
  await expect(page).toHaveURL(/\/settings$/);
});

test("does not show update banner when version.json matches the running build SHA", async ({
  page,
}) => {
  await setupAuth(page);
  let reportedSha = currentSha;
  await page.route("**/version.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: "0.1.1",
        sha: reportedSha,
        builtAt: "2026-01-01T00:00:00.000Z",
      }),
    }),
  );

  const banner = page
    .getByRole("status")
    .filter({ hasText: "A new version is available." });

  const firstResponse = page.waitForResponse("**/version.json");
  await page.goto("/dashboard");
  await expect(page.getByRole("tablist")).toBeVisible();
  await (await firstResponse).finished();
  // Two animation frames let the page parse the response and apply any state change.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expect(banner).toHaveCount(0);

  // Control: the same check flags a different SHA, so the absence above reflects the
  // SHA comparison and not a check that never ran.
  reportedSha = differentSha;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(banner).toBeVisible();
});

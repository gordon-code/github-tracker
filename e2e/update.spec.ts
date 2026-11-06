import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { setupAuth } from "./helpers";

const rawSha = (
  process.env.GITHUB_SHA ??
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" })
)
  .trim()
  .toLowerCase();
const currentSha = rawSha.slice(0, 12);
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
  let versionFetched = false;
  await page.route("**/version.json", (route) => {
    versionFetched = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: "0.1.1",
        sha: currentSha,
        builtAt: "2026-01-01T00:00:00.000Z",
      }),
    });
  });

  await page.goto("/dashboard");
  await expect(page.getByRole("tablist")).toBeVisible();
  await expect.poll(() => versionFetched).toBe(true);

  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "A new version is available." }),
  ).toHaveCount(0);
});

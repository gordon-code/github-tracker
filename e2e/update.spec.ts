import { test, expect, type Page } from "@playwright/test";
import { resolveGitSha } from "../vite-plugins/build-meta";
import { setupAuth } from "./helpers";

const currentSha = resolveGitSha();
const differentSha =
  currentSha === "111111111111" ? "222222222222" : "111111111111";

// A property set on `window` before a navigation survives a client-side route change
// and is gone after a full document reload.
type MarkedWindow = Window & { __spaMarker?: boolean };

async function triggerVersionCheck(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

test("shows update banner when version.json reports a new SHA and triggers full reload on navigation", { tag: "@cross-browser" }, async ({
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
  await expect(page.getByRole("tablist")).toBeVisible();
  // Poll-driven checks wait out the boot window, so a tab-visibility event runs the check.
  await triggerVersionCheck(page);

  const banner = page
    .getByRole("status")
    .filter({ hasText: "A new version is available." });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(banner.getByRole("link", { name: "Changelog" })).toBeVisible();

  await page.evaluate(() => {
    (window as MarkedWindow).__spaMarker = true;
  });
  const loadPromise = page.waitForEvent("load");
  await page.getByRole("link", { name: "Settings" }).click();
  await loadPromise;
  await expect(page).toHaveURL(/\/settings$/);
  expect(
    await page.evaluate(() => (window as MarkedWindow).__spaMarker),
  ).toBeUndefined();
});

test("does not show update banner or force a reload when version.json matches the running build SHA", { tag: "@cross-browser" }, async ({
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

  await page.goto("/dashboard");
  await expect(page.getByRole("tablist")).toBeVisible();
  const firstResponse = page.waitForResponse("**/version.json");
  await triggerVersionCheck(page);
  await (await firstResponse).finished();
  // Two animation frames let the page parse the response and apply any state change.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expect(banner).toHaveCount(0);

  // With no update pending, the Settings link stays a client-side route change.
  await page.evaluate(() => {
    (window as MarkedWindow).__spaMarker = true;
  });
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: /^settings$/i })).toBeVisible();
  expect(await page.evaluate(() => (window as MarkedWindow).__spaMarker)).toBe(true);

  // Control: the same check flags a different SHA, so the absence above reflects the
  // SHA comparison and not a check that never ran.
  reportedSha = differentSha;
  await triggerVersionCheck(page);
  await expect(banner).toBeVisible();
});

test("makes Settings read-only in a tab whose stored-data schema differs from the deployed build", { tag: "@cross-browser" }, async ({
  page,
}) => {
  await setupAuth(page, { theme: "dracula" });
  await page.route("**/version.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: "9.9.9",
        sha: differentSha,
        builtAt: "2026-01-02T00:00:00.000Z",
        schemaFp: "ffffffffffff",
      }),
    }),
  );

  await page.goto("/settings");
  const signOut = page.getByRole("button", { name: "Sign out" });
  await expect(signOut).toBeEnabled();

  await triggerVersionCheck(page);

  const banner = page
    .getByRole("status")
    .filter({ hasText: "This tab can't save changes, and Settings are read-only, until you reload." });
  await expect(banner).toBeVisible();
  await expect(signOut).toBeDisabled();

  // The region is inert, and the widgets that a disabled fieldset does not cover on its own
  // (Kobalte select triggers) are disabled themselves, so the lock does not rest on `inert`
  // support alone.
  await expect(page.locator("fieldset[inert]")).toHaveCount(1);
  const selectTriggers = page.locator("button.select");
  expect(await selectTriggers.count()).toBeGreaterThanOrEqual(3);
  for (const trigger of await selectTriggers.all()) await expect(trigger).toBeDisabled();

  // A forced click on the theme picker's "Auto" option must not change the theme. The page
  // starts on another theme, so a click that reached the option would switch it to "auto".
  const autoOption = page.locator('button[aria-label^="Theme: auto"]');
  await expect(autoOption).toBeDisabled();
  await expect(autoOption).toHaveAttribute("aria-pressed", "false");
  await autoOption.click({ force: true });
  await expect(autoOption).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dracula");
});

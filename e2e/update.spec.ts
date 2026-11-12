import { test, expect, type Page } from "@playwright/test";
import {
  CONFIG_KEY,
  NEWER_SHA,
  RUNNING_SHA,
  UPDATE_RELOADED_SHA_KEY,
  VIEW_KEY,
  countDocumentLoads,
  makeIssueNode,
  markWindow,
  mockGitHubApi,
  readStoredJson,
  repoGroupToggle,
  seedStorageOnce,
  serveVersionJson,
  settingsHeading,
  settleFrames,
  setupAuth,
  triggerVersionCheck,
  updateBanner,
  windowIsMarked,
  type DeployedBuild,
} from "./helpers";

const thirdSha = RUNNING_SHA === "333333333333" ? "444444444444" : "333333333333";

test("shows update banner when version.json reports a new SHA and triggers full reload on navigation", { tag: "@cross-browser" }, async ({
  page,
}) => {
  await setupAuth(page);
  await serveVersionJson(page, () => ({ sha: NEWER_SHA }));

  await page.goto("/dashboard");
  await expect(page.getByRole("tablist")).toBeVisible();
  // Poll-driven checks wait out the boot window, so a tab-visibility event runs the check.
  await triggerVersionCheck(page);

  const banner = updateBanner(page);
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(banner.getByRole("link", { name: "Changelog" })).toBeVisible();

  await markWindow(page);
  const loadPromise = page.waitForEvent("load");
  await page.getByRole("link", { name: "Settings" }).click();
  await loadPromise;
  await expect(page).toHaveURL(/\/settings$/);
  expect(await windowIsMarked(page)).toBe(false);
});

test("does not show update banner or force a reload when version.json matches the running build SHA", { tag: "@cross-browser" }, async ({
  page,
}) => {
  await setupAuth(page);
  let deployed: DeployedBuild = { sha: RUNNING_SHA };
  await serveVersionJson(page, () => deployed);

  await page.goto("/dashboard");
  await expect(page.getByRole("tablist")).toBeVisible();
  const firstResponse = page.waitForResponse("**/version.json");
  await triggerVersionCheck(page);
  await (await firstResponse).finished();
  await settleFrames(page);
  await expect(updateBanner(page)).toHaveCount(0);

  // With no update pending, the Settings link stays a client-side route change.
  await markWindow(page);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(settingsHeading(page)).toBeVisible();
  expect(await windowIsMarked(page)).toBe(true);

  // Control: the same check flags a different SHA, so the absence above reflects the
  // SHA comparison and not a check that never ran.
  deployed = { sha: NEWER_SHA };
  await triggerVersionCheck(page);
  await expect(updateBanner(page)).toBeVisible();
});

test("makes Settings read-only in a tab whose stored-data schema differs from the deployed build", { tag: "@cross-browser" }, async ({
  page,
}) => {
  await setupAuth(page, { theme: "dracula" });
  await serveVersionJson(page, () => ({ sha: NEWER_SHA, schemaFp: "ffffffffffff" }));

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

// ── UAT scenarios (tests/acceptance/update-detection-and-resilience.feature, @e2e) ────────
// These seed storage once per tab (seedStorageOnce) so a reload sees what the app saved.

test.describe("S6 - Reload button saves a just-changed setting before reloading", () => {
  test("the update banner is visible on the Settings page", async ({ page }) => {
    await mockGitHubApi(page);
    await seedStorageOnce(page);
    await serveVersionJson(page, () => ({ sha: NEWER_SHA }));
    const documentLoads = countDocumentLoads(page);

    await page.goto("/settings");
    await expect(settingsHeading(page)).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", "dracula");
    await triggerVersionCheck(page);
    await expect(updateBanner(page)).toBeVisible();

    // When the user changes a setting (picks a different theme) and immediately clicks
    // "Reload" in the banner. Both clicks run in one task, well inside the 200 ms write
    // debounce, so only the pre-reload flush can save the theme.
    const reloaded = page.waitForEvent("load");
    const storedThemeAtReload = await page.evaluate((configKey) => {
      const themeOption = document.querySelector<HTMLButtonElement>('button[aria-label="Theme: dracula"]');
      const reload = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="status"] button')).find(
        (button) => button.textContent?.trim() === "Reload",
      );
      if (!themeOption || !reload) throw new Error("Theme option or banner Reload button not found");
      themeOption.click();
      const stored = JSON.parse(localStorage.getItem(configKey) ?? "{}") as { theme?: string };
      // Next task, still well inside the debounce, so this evaluate returns before the reload.
      setTimeout(() => reload.click(), 0);
      return stored.theme ?? null;
    }, CONFIG_KEY);
    expect(storedThemeAtReload).not.toBe("dracula");

    // Then the page performs a full reload
    await reloaded;
    expect(documentLoads()).toBe(2);

    // And after the reload the changed setting is still applied
    await expect(settingsHeading(page)).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dracula");
    await expect(page.getByRole("button", { name: "Theme: dracula" })).toHaveAttribute("aria-pressed", "true");
    expect((await readStoredJson(page, CONFIG_KEY))?.theme).toBe("dracula");
  });
});

/**
 * Opens the dashboard with one issue in a collapsed repo group, makes the deployed build
 * differ from the running one, and runs a check so the update banner shows.
 */
async function openDashboardWithUpdateWaiting(page: Page, deployed: () => DeployedBuild): Promise<void> {
  await mockGitHubApi(page, { issues: [makeIssueNode()] });
  await seedStorageOnce(page);
  await serveVersionJson(page, deployed);
  await page.goto("/dashboard");
  await expect(page.getByRole("tablist")).toBeVisible();
  await expect(repoGroupToggle(page)).toHaveAttribute("aria-expanded", "false");
  await triggerVersionCheck(page);
  await expect(updateBanner(page)).toBeVisible();
}

test.describe("S7 - Navigating with an update waiting fully reloads into the new build and keeps pending view state", () => {
  test("an update is waiting and the dashboard shows the banner", async ({ page }) => {
    const documentLoads = countDocumentLoads(page);
    await openDashboardWithUpdateWaiting(page, () => ({ sha: NEWER_SHA }));

    // When the user expands a collapsed repo group and then clicks the header "Settings" link
    // straight away. The expansion is a debounced (200 ms) view-store write, so both clicks
    // run in one task: only the pre-navigation flush can save it.
    await markWindow(page);
    const reloaded = page.waitForEvent("load");
    const storedExpansionAtClick = await page.evaluate((viewKey) => {
      const toggle = Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")).find(
        (button) => button.textContent?.includes("testorg/testrepo"),
      );
      const settings = document.querySelector<HTMLAnchorElement>('a[aria-label="Settings"]');
      if (!toggle || !settings) throw new Error("Repo group toggle or Settings link not found");
      toggle.click();
      const expanded = toggle.getAttribute("aria-expanded");
      const stored = localStorage.getItem(viewKey) ?? "";
      setTimeout(() => settings.click(), 0);
      return { expanded, stored };
    }, VIEW_KEY);
    expect(storedExpansionAtClick.expanded).toBe("true");
    expect(storedExpansionAtClick.stored).not.toContain("testorg/testrepo");

    // Then the browser performs a full document load of /settings instead of a client-side
    // route change
    await reloaded;
    await expect(page).toHaveURL(/\/settings$/);
    expect(documentLoads()).toBe(2);
    expect(await windowIsMarked(page)).toBe(false);
    await expect(settingsHeading(page)).toBeVisible();

    // And after returning to the dashboard the repo group is still expanded
    await markWindow(page);
    await page.getByRole("link", { name: "Back to dashboard" }).click();
    await expect(page.getByRole("tablist")).toBeVisible();
    expect(await windowIsMarked(page)).toBe(true);
    await expect(repoGroupToggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("Version banner acceptance issue")).toBeVisible();
    const view = await readStoredJson(page, VIEW_KEY);
    expect(JSON.stringify(view?.expandedRepos)).toContain("testorg/testrepo");
  });
});

test.describe("S8 - Only one automatic reload per target build during a gradual rollout", () => {
  test("the tab has already reloaded once for the target build", async ({ page }) => {
    const documentLoads = countDocumentLoads(page);
    let deployed: DeployedBuild = { sha: NEWER_SHA };
    await openDashboardWithUpdateWaiting(page, () => deployed);

    // Given the tab has already reloaded once for the target build and /version.json still
    // reports that same target SHA
    const reloaded = page.waitForEvent("load");
    await page.getByRole("link", { name: "Settings" }).click();
    await reloaded;
    await expect(settingsHeading(page)).toBeVisible();
    expect(documentLoads()).toBe(2);

    // When the check runs again, the banner reappears, and the user navigates from Settings
    // back to the Dashboard
    await triggerVersionCheck(page);
    await expect(updateBanner(page)).toBeVisible();
    expect(await page.evaluate((key) => sessionStorage.getItem(key), UPDATE_RELOADED_SHA_KEY)).toBe(NEWER_SHA);
    await markWindow(page);
    await page.getByRole("link", { name: "Back to dashboard" }).click();

    // Then the navigation is a client-side route change with no further automatic reload
    await expect(page.getByRole("tablist")).toBeVisible();
    expect(await windowIsMarked(page)).toBe(true);
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(settingsHeading(page)).toBeVisible();
    await page.getByRole("link", { name: "Back to dashboard" }).click();
    await expect(page.getByRole("tablist")).toBeVisible();
    expect(await windowIsMarked(page)).toBe(true);
    expect(documentLoads()).toBe(2);

    // And the banner remains with its "Reload" button available for a manual reload
    await expect(updateBanner(page)).toBeVisible();
    await expect(updateBanner(page).getByRole("button", { name: "Reload" })).toBeEnabled();

    // A third build is a new target, so it gets exactly one reload of its own.
    deployed = { sha: thirdSha };
    const thirdCheck = page.waitForResponse("**/version.json");
    await triggerVersionCheck(page);
    await (await thirdCheck).finished();
    await settleFrames(page);
    const reloadedForThird = page.waitForEvent("load");
    await page.getByRole("link", { name: "Settings" }).click();
    await reloadedForThird;
    await expect(page).toHaveURL(/\/settings$/);
    await expect(settingsHeading(page)).toBeVisible();
    expect(documentLoads()).toBe(3);
    expect(await page.evaluate((key) => sessionStorage.getItem(key), UPDATE_RELOADED_SHA_KEY)).toBe(thirdSha);
    await triggerVersionCheck(page);
    await expect(updateBanner(page)).toBeVisible();
    await markWindow(page);
    await page.getByRole("link", { name: "Back to dashboard" }).click();
    await expect(page.getByRole("tablist")).toBeVisible();
    expect(await windowIsMarked(page)).toBe(true);
    expect(documentLoads()).toBe(3);
  });
});

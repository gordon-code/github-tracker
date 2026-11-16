import { test, expect, type Page } from "@playwright/test";
import {
  CHUNK_RELOAD_KEY,
  NEWER_SHA,
  RUNNING_SHA,
  VIEW_KEY,
  settingsHeading,
  updateBanner,
  countDocumentLoads,
  isVersionRequest,
  markWindow,
  mockGitHubApi,
  readStoredJson,
  seedStorageOnce,
  serveVersionJson,
  settleFrames,
  triggerVersionCheck,
  windowIsMarked,
  type DeployedBuild,
} from "./helpers";

// These scenarios run against `pnpm build && vite preview` (the `chromium-preview` project):
// they depend on Vite's production preload helper, which fires `vite:preloadError` when a
// hashed chunk under /_app/ fails to load. Playwright routing disables the HTTP cache, so a
// blocked chunk is never served from an earlier load.

test.describe.configure({ mode: "parallel" });

async function readChunkReloadStamp(page: Page): Promise<number | null> {
  const raw = await page.evaluate((key) => sessionStorage.getItem(key), CHUNK_RELOAD_KEY);
  return raw === null ? null : Number(raw);
}

/** Blocks a hashed chunk under /_app/ by its base name until the returned function is called. */
async function blockChunk(page: Page, baseName: string): Promise<() => Promise<void>> {
  const pattern = `**/_app/${baseName}-*.js`;
  await page.route(pattern, (route) => route.abort("failed"));
  return () => page.unroute(pattern);
}

async function openDashboard(page: Page): Promise<void> {
  await page.goto("/dashboard");
  await expect(page.getByRole("tablist")).toBeVisible();
}

const failedLoadCard = (page: Page) => page.getByText("Failed to load page");
const reloadPageButton = (page: Page) => page.getByRole("button", { name: "Reload page" });

test.describe("S13 - Failed lazy chunk with a known update reloads once", () => {
  test("an update is already known and the custom-tab dialog's chunk is blocked", async ({ page }) => {
    await mockGitHubApi(page);
    await seedStorageOnce(page);
    await serveVersionJson(page, () => ({ sha: NEWER_SHA }));
    const unblock = await blockChunk(page, "CustomTabModal");
    const documentLoads = countDocumentLoads(page);

    await openDashboard(page);
    await triggerVersionCheck(page);
    await expect(updateBanner(page)).toBeVisible();

    // A dashboard filter change made just before the failed load must survive the reload. The
    // filter pick is a debounced (200 ms) view-store write, so it and the "Add custom tab" click
    // run in one task: only the pre-reload flush can save it.
    await page.getByRole("button", { name: "Filter by Role" }).click();
    await expect(page.getByRole("button", { name: "Assignee", exact: true })).toBeVisible();

    // When the user clicks "Add custom tab" in the tab bar
    const reloaded = page.waitForEvent("load");
    const storedAtClick = await page.evaluate((viewKey) => {
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
      const assignee = buttons.find((b) => b.textContent?.trim() === "Assignee");
      const addTab = document.querySelector<HTMLButtonElement>('button[aria-label="Add custom tab"]');
      if (!assignee || !addTab) throw new Error("Role option or Add custom tab button not found");
      assignee.click();
      const stored = localStorage.getItem(viewKey) ?? "";
      setTimeout(() => addTab.click(), 0);
      return stored;
    }, VIEW_KEY);
    expect(storedAtClick).not.toContain('"role":"assignee"');

    // Then the page reloads once immediately
    await reloaded;
    expect(documentLoads()).toBe(2);
    const stamp = await readChunkReloadStamp(page);
    expect(stamp).not.toBeNull();
    expect(Date.now() - stamp!).toBeLessThan(10_000);
    await expect(page.getByRole("tablist")).toBeVisible();
    await expect(page.getByRole("button", { name: "Filter by Role" })).toHaveText(/Role: Assignee/);
    const view = await readStoredJson(page, VIEW_KEY);
    expect((view?.tabFilters as { issues?: { role?: string } } | undefined)?.issues?.role).toBe("assignee");

    // And a second failure within 10 seconds of that reload shows the "Failed to load page"
    // card instead of reloading again
    await page.getByRole("button", { name: "Add custom tab" }).click();
    await expect(failedLoadCard(page)).toBeVisible();
    await expect(reloadPageButton(page)).toBeVisible();
    // Give a reload that should not happen time to start.
    await page.waitForTimeout(1_000);
    expect(documentLoads()).toBe(2);
    expect(Date.now() - stamp!).toBeLessThan(10_000);

    // Removing the block and clicking "Reload page" brings the dashboard back.
    await unblock();
    const manualReload = page.waitForEvent("load");
    await reloadPageButton(page).click();
    await manualReload;
    await expect(page.getByRole("tablist")).toBeVisible();
  });
});

test.describe("S14 - Failed route chunk with no known update reloads once on its own, then shows the load-failure card", () => {
  test("no newer build is known and the Settings page chunk is blocked", async ({ page }) => {
    await mockGitHubApi(page);
    await seedStorageOnce(page);
    await serveVersionJson(page, () => ({ sha: RUNNING_SHA }));
    const unblock = await blockChunk(page, "SettingsPage");
    const documentLoads = countDocumentLoads(page);

    await openDashboard(page);
    await expect(updateBanner(page)).toHaveCount(0);

    // When the user clicks the header "Settings" link
    const reloaded = page.waitForEvent("load");
    await page.getByRole("link", { name: "Settings" }).click();

    // Then the page reloads once on its own
    await reloaded;
    await expect(page).toHaveURL(/\/settings$/);
    expect(documentLoads()).toBe(2);
    expect(await readChunkReloadStamp(page)).not.toBeNull();

    // And when the chunk still fails after the reload, a "Failed to load page" card with a
    // "Reload page" button is shown instead of another reload
    await expect(failedLoadCard(page)).toBeVisible();
    await expect(reloadPageButton(page)).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(documentLoads()).toBe(2);
    await expect(updateBanner(page)).toHaveCount(0);

    // Removing the block and clicking "Reload page" loads Settings.
    await unblock();
    const manualReload = page.waitForEvent("load");
    await reloadPageButton(page).click();
    await manualReload;
    await expect(settingsHeading(page)).toBeVisible();
  });
});

// Needs the preview build: under `vite dev` the HMR client reacts to the dropped connection and
// reloads on reconnect, which is dev-server behaviour, not the app's.
test.describe("S15 - Offline route chunk failure never reloads", () => {
  test("the browser reports being offline", async ({ page, context }) => {
    await mockGitHubApi(page);
    await seedStorageOnce(page);
    await serveVersionJson(page, () => ({ sha: RUNNING_SHA }));
    const documentLoads = countDocumentLoads(page);

    await openDashboard(page);
    await expect(updateBanner(page)).toHaveCount(0);

    // Given the browser reports being offline
    await markWindow(page);
    await context.setOffline(true);
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);

    // When the user clicks the header "Settings" link before the Settings code has been loaded
    await page.getByRole("link", { name: "Settings" }).click();

    // Then no automatic reload happens
    await expect(failedLoadCard(page)).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(documentLoads()).toBe(1);
    expect(await windowIsMarked(page)).toBe(true);
    expect(await readChunkReloadStamp(page)).toBeNull();

    // And the "Failed to load page" card with "Reload page" is shown, and clicking it after
    // going back online fully reloads into Settings
    await expect(reloadPageButton(page)).toBeVisible();
    await context.setOffline(false);
    const reloaded = page.waitForEvent("load");
    await reloadPageButton(page).click();
    await reloaded;
    expect(documentLoads()).toBe(2);
    expect(await windowIsMarked(page)).toBe(false);
    await expect(page).toHaveURL(/\/settings$/);
    await expect(settingsHeading(page)).toBeVisible();
  });
});

test.describe("S34 - Failed on-demand module with no known update checks first and reloads once when the check finds a newer build", () => {
  test("no newer build is known and the changelog chunk is blocked", async ({ page }) => {
    await mockGitHubApi(page);
    await seedStorageOnce(page);
    let deployed: DeployedBuild = { sha: RUNNING_SHA };
    await serveVersionJson(page, () => deployed);
    await blockChunk(page, "_virtual_changelog");
    const documentLoads = countDocumentLoads(page);
    let versionRequests = 0;
    // Version checks made before the reload starts, snapshotted when its document request fires.
    let requestsBeforeReload: number | null = null;
    let navigations = 0;
    page.on("request", (request) => {
      if (isVersionRequest(request)) versionRequests++;
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && ++navigations === 2) {
        requestsBeforeReload = versionRequests;
      }
    });

    // Given no newer build is known and the changelog chunk is blocked, so the header's idle
    // load already failed without a reload
    await openDashboard(page);
    // The failed idle import runs a check, which finds the running build.
    await expect.poll(() => versionRequests, { timeout: 3_000 }).toBe(1);
    await page.waitForTimeout(500);
    expect(documentLoads()).toBe(1);
    expect(await readChunkReloadStamp(page)).toBeNull();
    await expect(updateBanner(page)).toHaveCount(0);

    // When the deployed /version.json starts reporting a different SHA, with no check having
    // run since, and the user opens What's New
    deployed = { sha: NEWER_SHA };
    await markWindow(page);
    const reloaded = page.waitForEvent("load");
    await page.getByRole("button", { name: /^What's new/ }).click();

    // Then the failed import triggers an update check, the check finds the newer build, and
    // the page reloads exactly once
    await reloaded;
    // The idle-load check plus the check the click's failed import ran before reloading.
    expect(requestsBeforeReload).not.toBeNull();
    expect(requestsBeforeReload!).toBeGreaterThanOrEqual(2);
    expect(documentLoads()).toBe(2);
    expect(await windowIsMarked(page)).toBe(false);
    const stamp = await readChunkReloadStamp(page);
    expect(stamp).not.toBeNull();

    // And after the reload the header's repeated import failure inside the 10-second window
    // causes no second reload, and the update banner appears on the next check
    await expect(page.getByRole("tablist")).toBeVisible();
    // The repeated idle-import failure runs its own check.
    await expect.poll(() => versionRequests, { timeout: 3_000 }).toBeGreaterThan(requestsBeforeReload!);
    await settleFrames(page);
    await page.waitForTimeout(500);
    expect(documentLoads()).toBe(2);
    expect(Date.now() - stamp!).toBeLessThan(10_000);

    await triggerVersionCheck(page);
    await expect(updateBanner(page)).toBeVisible();
    expect(documentLoads()).toBe(2);
  });
});

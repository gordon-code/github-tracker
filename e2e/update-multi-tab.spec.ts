import { readFile } from "node:fs/promises";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import {
  AUTH_TOKEN_KEY,
  CONFIG_KEY,
  NEWER_SHA,
  RUNNING_SHA,
  TEST_REPO,
  TEST_USER,
  VIEW_KEY,
  countDocumentLoads,
  fakePat,
  makeIssueNode,
  makePullRequestNode,
  markWindow,
  mockGitHubApi,
  readStoredJson,
  readStoredRaw,
  repoGroupToggle,
  seedStorageOnce,
  serveVersionJson,
  settingsHeading,
  triggerVersionCheck,
  updateBanner,
  windowIsMarked,
  type DeployedBuild,
  type GitHubApiData,
  type SeedOptions,
} from "./helpers";

// Each test builds its own context, routes and storage, so the tests run in parallel.
test.describe.configure({ mode: "parallel" });

// UAT scenarios from tests/acceptance/update-detection-and-resilience.feature (@e2e) that need
// two tabs sharing one browser profile: both pages live in one context, so they share
// localStorage and receive each other's `storage` events, as two real tabs do.

const FOREIGN_SCHEMA_FP = "ffffffffffff";

const READ_ONLY_SENTENCE = "This tab can't save changes, and Settings are read-only, until you reload.";
const UNCONFIRMED_ACCOUNT_WARNING =
  "Another tab changed the signed-in account and this tab couldn't confirm which one. Changes here aren't being saved — reload this tab to continue.";

interface Tabs {
  tabA: Page;
  tabB: Page;
}

async function openTwoTabs(
  context: BrowserContext,
  options: { api?: GitHubApiData; seed?: SeedOptions } = {},
): Promise<Tabs> {
  await mockGitHubApi(context, options.api);
  await seedStorageOnce(context, options.seed);
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  return { tabA, tabB };
}

async function gotoDashboard(page: Page): Promise<void> {
  await page.goto("/dashboard");
  await expect(page.getByRole("tablist")).toBeVisible();
}

async function gotoSettings(page: Page): Promise<void> {
  await page.goto("/settings");
  await expect(settingsHeading(page)).toBeVisible();
}

const html = (page: Page) => page.locator("html");
const roleFilter = (page: Page) => page.getByRole("button", { name: "Filter by Role" });
const themeOption = (page: Page, theme: string) => page.getByRole("button", { name: `Theme: ${theme}` });

/** The Kobalte select trigger inside the Settings row with this label. */
function settingSelect(page: Page, rowLabel: string) {
  return page
    .locator("div.flex.items-center.justify-between")
    .filter({ has: page.getByText(rowLabel, { exact: true }) })
    .locator("button.select");
}

async function chooseSetting(page: Page, rowLabel: string, option: string): Promise<void> {
  await settingSelect(page, rowLabel).click();
  await page.getByRole("option", { name: option }).click();
}

async function setIssuesRoleFilter(page: Page, option: string): Promise<void> {
  await roleFilter(page).click();
  await page.getByRole("button", { name: option, exact: true }).click();
  await expect(roleFilter(page)).toHaveText(new RegExp(`Role: ${option}`));
}


/** Lets debounced (200 ms) writes and the storage events they raise in other tabs land. */
async function letWritesLand(page: Page): Promise<void> {
  await page.waitForTimeout(600);
}

/** For `expect.poll`: one top-level field of a stored JSON blob, as JSON text. */
function storedField(page: Page, key: string, field: string): () => Promise<string> {
  return async () => JSON.stringify((await readStoredJson(page, key))?.[field] ?? null);
}

/** Opens the Notification Drawer, returns its text, and closes it again. */
async function drawerText(page: Page): Promise<string> {
  await page.getByRole("button", { name: /^Notifications/ }).click();
  const drawer = page.getByRole("dialog", { name: "Notifications" }).or(
    page.getByRole("alertdialog", { name: "Notifications" }),
  );
  await expect(drawer).toBeVisible();
  const text = (await drawer.textContent()) ?? "";
  await page.getByRole("button", { name: "Close notifications" }).click();
  await expect(drawer).toHaveCount(0);
  return text;
}

async function replaceTokenInSettings(page: Page, newToken: string): Promise<void> {
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await page.getByLabel("New personal access token").fill(newToken);
  await page.getByRole("button", { name: "Replace token" }).click();
  await expect(page.getByLabel("New personal access token")).toHaveCount(0);
  expect(await readStoredRaw(page, AUTH_TOKEN_KEY)).toBe(newToken);
}

// ── S19 ──────────────────────────────────────────────────────────────────────

test.describe("S19 - Dashboard changes made in an older-build tab are not saved", () => {
  test("Tab A is read-only because of a schema mismatch and Tab B is normal", async ({ context }) => {
    const assignedIssue = makeIssueNode({
      author: { login: "octocat" },
      assignees: { nodes: [{ login: TEST_USER.login, avatarUrl: TEST_USER.avatar_url }] },
    });
    const { tabA, tabB } = await openTwoTabs(context, { api: { issues: [assignedIssue] } });
    let deployedForA: DeployedBuild = { sha: NEWER_SHA, schemaFp: FOREIGN_SCHEMA_FP };
    await serveVersionJson(tabA, () => deployedForA);
    await serveVersionJson(tabB, () => ({ sha: RUNNING_SHA }));
    await gotoDashboard(tabA);
    await gotoDashboard(tabB);
    for (const tab of [tabA, tabB]) {
      await expect(roleFilter(tab)).toHaveText(/^\s*Role\s*$/);
      await expect(repoGroupToggle(tab)).toHaveAttribute("aria-expanded", "false");
    }
    const themeBefore = await html(tabA).getAttribute("data-theme");
    expect(themeBefore).not.toBe("dracula");

    // Given Tab A is read-only because of a schema mismatch and Tab B is normal
    await triggerVersionCheck(tabA);
    await expect(updateBanner(tabA)).toContainText(READ_ONLY_SENTENCE);
    const viewBefore = await readStoredRaw(tabB, VIEW_KEY);

    // When the user sets the Issues Role filter to "Assignee" and expands a repo group in
    // Tab A, staying on the dashboard
    await setIssuesRoleFilter(tabA, "Assignee");
    await repoGroupToggle(tabA).click();
    await expect(repoGroupToggle(tabA)).toHaveAttribute("aria-expanded", "true");
    await letWritesLand(tabA);

    // Then Tab B keeps its previous filter and collapsed group, and Tab A does not adopt a
    // theme changed in Tab B meanwhile
    await expect(roleFilter(tabB)).toHaveText(/^\s*Role\s*$/);
    await expect(repoGroupToggle(tabB)).toHaveAttribute("aria-expanded", "false");
    expect(await readStoredRaw(tabB, VIEW_KEY)).toBe(viewBefore);

    await tabB.getByRole("link", { name: "Settings" }).click();
    await themeOption(tabB, "dracula").click();
    await expect(html(tabB)).toHaveAttribute("data-theme", "dracula");
    await expect.poll(storedField(tabB, CONFIG_KEY, "theme")).toBe('"dracula"');
    // The write has landed; give a read-only tab that wrongly adopted it time to re-theme.
    await tabA.waitForTimeout(400);
    await expect(html(tabA)).toHaveAttribute("data-theme", themeBefore!);

    // And after Tab A reloads without the override, its filter is back to the previous value
    // and the group is collapsed again (reloaded straight away, without a tab switch that
    // would run a check first)
    deployedForA = { sha: RUNNING_SHA };
    await tabA.reload();
    await expect(tabA.getByRole("tablist")).toBeVisible();
    await expect(roleFilter(tabA)).toHaveText(/^\s*Role\s*$/);
    await expect(repoGroupToggle(tabA)).toHaveAttribute("aria-expanded", "false");
    await expect(html(tabA)).toHaveAttribute("data-theme", "dracula");

    // The reloaded tab behaves normally again: Tab B's expansion appears in Tab A live.
    await tabB.getByRole("link", { name: "Back to dashboard" }).click();
    await repoGroupToggle(tabB).click();
    await expect(repoGroupToggle(tabA)).toHaveAttribute("aria-expanded", "true");
  });
});

// ── S20 ──────────────────────────────────────────────────────────────────────

test.describe("S20 - Settings and view changes sync live to other tabs", () => {
  test("Tab A is on Settings and Tab B is on the dashboard", async ({ context }) => {
    const customTab = { id: "triage", name: "Triage", baseType: "issues" };
    const { tabA, tabB } = await openTwoTabs(context, {
      api: { issues: [makeIssueNode()], pullRequests: [makePullRequestNode()] },
      seed: { config: { customTabs: [customTab] } },
    });
    for (const tab of [tabA, tabB]) await serveVersionJson(tab, () => ({ sha: RUNNING_SHA }));
    await gotoSettings(tabA);
    await gotoDashboard(tabB);
    const tabBLoads = countDocumentLoads(tabB);
    await markWindow(tabB);

    // When the user changes the theme in Tab A ...
    await themeOption(tabA, "dracula").click();

    // Then Tab B switches to the new theme within a second without reloading
    await expect(html(tabB)).toHaveAttribute("data-theme", "dracula", { timeout: 1_000 });
    expect(await windowIsMarked(tabB)).toBe(true);
    expect(tabBLoads()).toBe(0);

    // ... then changes the Pull Requests sort order and expands a repo group in Tab B
    await tabB.getByRole("tab", { name: /Pull Requests/ }).click();
    await tabB.getByRole("button", { name: "Sort by" }).click();
    await tabB.getByRole("option", { name: "Title (A-Z)" }).click();
    await expect(tabB.getByRole("button", { name: "Sort by" })).toHaveText(/Title \(A-Z\)/);
    await repoGroupToggle(tabB).click();
    await expect(repoGroupToggle(tabB)).toHaveAttribute("aria-expanded", "true");
    await expect.poll(storedField(tabB, VIEW_KEY, "expandedRepos")).toContain(TEST_REPO.fullName);

    // And Tab A, when it returns to the dashboard, shows the new sort order and the
    // expanded group
    await tabA.getByRole("link", { name: "Back to dashboard" }).click();
    await expect(tabA.getByRole("tablist")).toBeVisible();
    await tabA.getByRole("tab", { name: /Pull Requests/ }).click();
    await expect(tabA.getByRole("button", { name: "Sort by" })).toHaveText(/Title \(A-Z\)/);
    await expect(repoGroupToggle(tabA)).toHaveAttribute("aria-expanded", "true");
    await expect(tabA.getByText("Version banner acceptance pull request")).toBeVisible();

    // The theme "Auto" option is a real button, operable from the keyboard.
    await tabA.getByRole("link", { name: "Settings" }).click();
    await expect(settingsHeading(tabA)).toBeVisible();
    // Reach it with the Tab key from the previous control (a tabindex=-1 element can be
    // focused programmatically but would be skipped here).
    const autoOption = themeOption(tabA, "auto (follows system)");
    await autoOption.focus();
    await tabA.keyboard.press("Shift+Tab");
    await expect(autoOption).not.toBeFocused();
    await tabA.keyboard.press("Tab");
    await expect(autoOption).toBeFocused();
    await tabA.keyboard.press("Enter");
    await expect(themeOption(tabA, "auto (follows system)")).toHaveAttribute("aria-pressed", "true");
    const autoTheme = await html(tabA).getAttribute("data-theme");
    expect(autoTheme).not.toBe("dracula");
    await expect(html(tabB)).toHaveAttribute("data-theme", autoTheme!, { timeout: 1_000 });

    // Repair on adoption: a default tab pointing at a custom tab deleted in another tab falls
    // back to Issues.
    await chooseSetting(tabA, "Default tab", customTab.name);
    await expect(settingSelect(tabA, "Default tab")).toHaveText(new RegExp(customTab.name));
    await expect.poll(storedField(tabA, CONFIG_KEY, "defaultTab")).toBe(JSON.stringify(customTab.id));
    await tabB.getByRole("link", { name: "Settings" }).click();
    await expect(settingsHeading(tabB)).toBeVisible();
    await tabB.getByRole("button", { name: `Delete "${customTab.name}"` }).click();
    await tabB.getByRole("button", { name: `Confirm delete "${customTab.name}"` }).click();
    await expect(settingSelect(tabA, "Default tab")).toHaveText(/Issues/);
    await tabA.getByRole("link", { name: "Back to dashboard" }).click();
    await expect(tabA.getByRole("tablist")).toBeVisible();
    await expect(tabA.getByRole("tab", { name: new RegExp(customTab.name) })).toHaveCount(0);
  });
});

// ── S21 ──────────────────────────────────────────────────────────────────────

test.describe("S21 - Pre-reload flush writes only this tab's changed keys", () => {
  test("Tab A has just changed the theme and Tab B has an update waiting", async ({ context }) => {
    const { tabA, tabB } = await openTwoTabs(context, { seed: { config: { refreshInterval: 300 } } });
    await serveVersionJson(tabA, () => ({ sha: RUNNING_SHA }));
    await serveVersionJson(tabB, () => ({ sha: NEWER_SHA }));
    await gotoSettings(tabA);
    await gotoSettings(tabB);
    for (const tab of [tabA, tabB]) {
      await expect(settingSelect(tab, "Refresh interval")).toHaveText(/5 minutes/);
    }
    await triggerVersionCheck(tabB);
    await expect(updateBanner(tabB)).toBeVisible();

    // Given Tab A has just changed the theme
    await themeOption(tabA, "dracula").click();
    await expect.poll(storedField(tabA, CONFIG_KEY, "theme")).toBe('"dracula"');

    // When the user changes the refresh interval in Tab B to 10 minutes and immediately clicks
    // "Back to dashboard", triggering Tab B's automatic reload
    await chooseSetting(tabB, "Refresh interval", "10 minutes");
    const reloaded = tabB.waitForEvent("load");
    await tabB.getByRole("link", { name: "Back to dashboard" }).click();
    await reloaded;

    // Then after Tab B reloads it shows Tab A's theme and a 10-minute refresh interval
    await expect(tabB.getByRole("tablist")).toBeVisible();
    await expect(html(tabB)).toHaveAttribute("data-theme", "dracula");
    await tabB.getByRole("link", { name: "Settings" }).click();
    await expect(settingSelect(tabB, "Refresh interval")).toHaveText(/10 minutes/);

    // And Tab A also shows the 10-minute refresh interval with its theme intact
    await expect(settingSelect(tabA, "Refresh interval")).toHaveText(/10 minutes/);
    await expect(html(tabA)).toHaveAttribute("data-theme", "dracula");
    await expect(themeOption(tabA, "dracula")).toHaveAttribute("aria-pressed", "true");
    const stored = await readStoredJson(tabA, CONFIG_KEY);
    expect(stored?.theme).toBe("dracula");
    expect(stored?.refreshInterval).toBe(600);
  });
});

// ── S22 ──────────────────────────────────────────────────────────────────────

test.describe("S22 - Sign-out in another tab signs this tab out too", () => {
  test("Tab A is on the dashboard and Tab B is on Settings", async ({ context }) => {
    const assignedIssue = makeIssueNode({
      assignees: { nodes: [{ login: TEST_USER.login, avatarUrl: TEST_USER.avatar_url }] },
    });
    const { tabA, tabB } = await openTwoTabs(context, {
      api: { issues: [assignedIssue] },
      seed: {
        config: {
          trackedUsers: [{ login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/u/583231", name: null }],
        },
      },
    });
    for (const tab of [tabA, tabB]) await serveVersionJson(tab, () => ({ sha: RUNNING_SHA }));
    await gotoDashboard(tabA);
    await gotoSettings(tabB);
    // Account data that must not survive the sign-out.
    await setIssuesRoleFilter(tabA, "Assignee");
    await repoGroupToggle(tabA).click();
    await expect.poll(storedField(tabA, VIEW_KEY, "tabFilters")).toContain("assignee");
    await expect.poll(storedField(tabA, VIEW_KEY, "expandedRepos")).toContain(TEST_REPO.fullName);
    const configBeforeSignOut = await readStoredJson(tabA, CONFIG_KEY);
    expect(configBeforeSignOut?.selectedRepos).toHaveLength(1);
    expect(configBeforeSignOut?.trackedUsers).toHaveLength(1);
    const tabALoads = countDocumentLoads(tabA);
    await markWindow(tabA);

    // When the user clicks Sign out in Tab B
    await tabB.getByRole("button", { name: "Sign out" }).click();
    await expect(tabB).toHaveURL(/\/login$/);

    // Then Tab A performs a full navigation to the sign-in page with no error toast
    await expect(tabA).toHaveURL(/\/login$/);
    await expect(tabA.getByRole("button", { name: /Sign in with GitHub/i })).toBeVisible();
    expect(tabALoads()).toBe(1);
    expect(await windowIsMarked(tabA)).toBe(false);
    await expect(tabA.getByRole("alert")).toHaveCount(0);

    // And the auth token is gone from localStorage and the config and view-state entries hold
    // only defaults, so Tab A wrote nothing back over the cleared account
    await tabA.waitForTimeout(2_000);
    await expect(tabA.getByRole("alert")).toHaveCount(0);
    expect(await readStoredRaw(tabA, AUTH_TOKEN_KEY)).toBeNull();
    const config = await readStoredJson(tabA, CONFIG_KEY);
    if (config !== null) {
      expect(config.selectedRepos ?? []).toEqual([]);
      expect(config.selectedOrgs ?? []).toEqual([]);
      expect(config.trackedUsers ?? []).toEqual([]);
      expect(config.onboardingComplete ?? false).toBe(false);
    }
    const view = await readStoredJson(tabA, VIEW_KEY);
    if (view !== null) {
      expect(JSON.stringify(view.tabFilters ?? {})).not.toContain("assignee");
      expect(JSON.stringify(view.expandedRepos ?? {})).not.toContain(TEST_REPO.fullName);
    }
  });
});

// ── S23 / S24 ────────────────────────────────────────────────────────────────

const FIRST_PAT = fakePat("a");
const SECOND_PAT = fakePat("b");
const PAT_SEED: SeedOptions = { token: FIRST_PAT, config: { authMethod: "pat" } };

test.describe("S23 - Same-user token replaced in another tab keeps this tab signed in and saving", () => {
  test("Tab B replaces the stored token with a second PAT for the same GitHub user", async ({ context }) => {
    const { tabA, tabB } = await openTwoTabs(context, { seed: PAT_SEED });
    for (const tab of [tabA, tabB]) await serveVersionJson(tab, () => ({ sha: RUNNING_SHA }));
    await gotoDashboard(tabA);
    await expect(tabA.getByRole("img", { name: TEST_USER.login })).toBeVisible();
    await gotoSettings(tabB);
    await expect(tabB.getByText("Personal Access Token", { exact: true })).toBeVisible();

    // Given Tab B replaces the stored token with a second PAT for the same GitHub user via
    // Settings > Data > Authentication > "Replace"
    const userCheckInA = tabA.waitForResponse(
      (response) =>
        response.url() === "https://api.github.com/user" &&
        response.request().headers().authorization === `Bearer ${SECOND_PAT}`,
    );
    await replaceTokenInSettings(tabB, SECOND_PAT);

    // When Tab A receives the new token and confirms the user
    await userCheckInA;
    await tabA.waitForTimeout(1_000);

    // Then within 10 seconds Tab A shows no warning toast or drawer entry and still shows the
    // same signed-in user
    await expect(tabA.getByRole("alert").filter({ hasText: UNCONFIRMED_ACCOUNT_WARNING })).toHaveCount(0);
    expect(await drawerText(tabA)).not.toContain(UNCONFIRMED_ACCOUNT_WARNING);
    await expect(tabA.getByRole("img", { name: TEST_USER.login })).toBeVisible();
    await expect(tabA).toHaveURL(/\/dashboard$/);

    // And a theme changed in Tab A afterwards is saved and appears in Tab B
    await tabA.getByRole("link", { name: "Settings" }).click();
    await themeOption(tabA, "dracula").click();
    await expect(html(tabB)).toHaveAttribute("data-theme", "dracula", { timeout: 2_000 });
    expect((await readStoredJson(tabA, CONFIG_KEY))?.theme).toBe("dracula");
    await tabA.reload();
    await expect(settingsHeading(tabA)).toBeVisible();
    await expect(html(tabA)).toHaveAttribute("data-theme", "dracula");
  });
});

test.describe("S24 - Token replaced in another tab and user cannot be confirmed: warning asks to reload", () => {
  test("Tab A cannot reach the GitHub user endpoint", async ({ context }) => {
    const { tabA, tabB } = await openTwoTabs(context, { seed: PAT_SEED });
    for (const tab of [tabA, tabB]) await serveVersionJson(tab, () => ({ sha: RUNNING_SHA }));
    await gotoDashboard(tabA);
    await gotoSettings(tabB);
    const themeBefore = await html(tabA).getAttribute("data-theme");
    expect(themeBefore).not.toBe("dracula");

    // Given Tab A cannot reach the GitHub user endpoint (page routes take precedence over the
    // context's /user mock; Tab B still reaches it)
    await tabA.route("https://api.github.com/user", (route) => route.abort());

    // When Tab B replaces the stored token via Settings > Data > Authentication > "Replace"
    await replaceTokenInSettings(tabB, SECOND_PAT);

    // Then Tab A promptly shows the warning
    await expect(tabA.getByRole("alert").filter({ hasText: UNCONFIRMED_ACCOUNT_WARNING })).toBeVisible({
      timeout: 5_000,
    });
    expect(await drawerText(tabA)).toContain(UNCONFIRMED_ACCOUNT_WARNING);

    // And a theme changed in Tab A is not saved until the tab is reloaded
    const configBefore = await readStoredRaw(tabA, CONFIG_KEY);
    await tabA.getByRole("link", { name: "Settings" }).click();
    await themeOption(tabA, "dracula").click();
    await expect(html(tabA)).toHaveAttribute("data-theme", "dracula");
    await letWritesLand(tabA);
    expect(await readStoredRaw(tabA, CONFIG_KEY)).toBe(configBefore);
    await expect(html(tabB)).toHaveAttribute("data-theme", themeBefore!);

    await tabA.unroute("https://api.github.com/user");
    await tabA.reload();
    await expect(settingsHeading(tabA)).toBeVisible();
    await expect(html(tabA)).toHaveAttribute("data-theme", themeBefore!);
    await expect(themeOption(tabA, "dracula")).toHaveAttribute("aria-pressed", "false");

    // After the reload, saving works again: the same change now lands and reaches Tab B.
    await themeOption(tabA, "dracula").click();
    await expect.poll(storedField(tabA, CONFIG_KEY, "theme")).toBe('"dracula"');
    await expect(html(tabB)).toHaveAttribute("data-theme", "dracula", { timeout: 2_000 });
  });
});

// ── S33 ──────────────────────────────────────────────────────────────────────

test.describe("S33 - Settings import in one tab replaces the stored config wholesale and other tabs adopt it", () => {
  test("Tab B changed the theme a few seconds ago and that change has been saved", async ({ context }) => {
    const repo = (name: string) => ({ owner: TEST_REPO.owner, name, fullName: `${TEST_REPO.owner}/${name}` });
    const { tabA, tabB } = await openTwoTabs(context);
    // Manage Repositories lists the org's repos from the REST API. The user's org and personal
    // repo lists are answered too, so they are not aborted and retried with backoff.
    await context.route("https://api.github.com/user/orgs*", (route) =>
      route.fulfill({ status: 200, json: [{ login: "testorg", avatar_url: "https://github.com/testorg.png" }] }),
    );
    await context.route("https://api.github.com/user/repos*", (route) => route.fulfill({ status: 200, json: [] }));
    await context.route("https://api.github.com/orgs/testorg/repos*", (route) =>
      route.fulfill({
        status: 200,
        json: ["testrepo", "otherrepo", "thirdrepo"].map((name) => ({
          name,
          full_name: `testorg/${name}`,
          owner: { login: "testorg" },
          pushed_at: "2026-11-01T00:00:00Z",
          fork: false,
          archived: false,
        })),
      }),
    );
    for (const tab of [tabA, tabB]) await serveVersionJson(tab, () => ({ sha: RUNNING_SHA }));
    await gotoSettings(tabA);
    await gotoSettings(tabB);

    // A plaintext export ("Export config only") from this account, edited so `theme` differs
    // from both tabs and `selectedRepos` lists a different subset of repos.
    const download = tabA.waitForEvent("download");
    await tabA.getByRole("button", { name: "Export", exact: true }).click();
    await tabA.getByRole("button", { name: "Export config only" }).click();
    const exported = JSON.parse(await readFile(await (await download).path(), "utf8")) as Record<string, unknown>;
    expect(exported.theme).not.toBe("nord");
    const imported: Record<string, unknown> = {
      ...exported,
      theme: "nord",
      selectedRepos: [repo("testrepo"), repo("otherrepo")],
    };

    // Given Tab B changed the theme a few seconds ago and that change has been saved
    await themeOption(tabB, "dracula").click();
    await expect.poll(storedField(tabB, CONFIG_KEY, "theme")).toBe('"dracula"');
    await expect(html(tabA)).toHaveAttribute("data-theme", "dracula");
    await markWindow(tabB);
    const tabBLoads = countDocumentLoads(tabB);

    // When the user imports the edited settings file in Tab A via Settings > Data > Import
    // settings and confirms with "Yes, import"
    await tabA.getByLabel("Import settings file").setInputFiles({
      name: "github-tracker-settings.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(imported, null, 2)),
    });
    await expect(tabA.getByText("This will replace your current settings — continue?")).toBeVisible();
    await tabA.getByRole("button", { name: "Yes, import" }).click();
    await expect(html(tabA)).toHaveAttribute("data-theme", "nord");
    await expect.poll(storedField(tabA, CONFIG_KEY, "theme")).toBe('"nord"');

    // Then the stored config equals the imported file, so Tab B's earlier theme is replaced
    // rather than merged
    const { _exportVersion: _version, _viewPreferences: _view, ...importedConfig } = imported;
    const stored = await readStoredJson(tabA, CONFIG_KEY);
    // Every exported key holds exactly the file's value. The stored blob may also carry
    // fields the export leaves out on purpose (credential-adjacent keys), so this is a
    // deep match on the file's keys rather than whole-object equality.
    expect(stored).toMatchObject(importedConfig);
    expect(stored?.theme).toBe("nord");

    // And Tab B switches to the imported theme and shows the imported repo list without a
    // reload
    await expect(html(tabB)).toHaveAttribute("data-theme", "nord", { timeout: 1_000 });
    await expect(tabB.getByText("2 selected", { exact: true })).toBeVisible();
    expect(await windowIsMarked(tabB)).toBe(true);
    expect(tabBLoads()).toBe(0);

    // A later repo edit in Tab B builds on the imported list instead of its pre-import copy.
    await tabB.getByRole("button", { name: "Manage Repositories" }).click();
    const repoCheckbox = (name: string) => tabB.locator("label", { hasText: name }).getByRole("checkbox");
    // Tab B's repo list is the imported one.
    await expect(repoCheckbox("testrepo")).toBeChecked();
    await expect(repoCheckbox("otherrepo")).toBeChecked();
    await expect(repoCheckbox("thirdrepo")).not.toBeChecked();
    await repoCheckbox("thirdrepo").check();
    await expect.poll(storedField(tabB, CONFIG_KEY, "selectedRepos")).toContain("testorg/thirdrepo");
    const afterEdit = await readStoredJson(tabB, CONFIG_KEY);
    const selectedAfterEdit = (afterEdit?.selectedRepos ?? []) as Array<{ fullName: string }>;
    const fullNames = selectedAfterEdit.map((r) => r.fullName).toSorted();
    expect(fullNames).toEqual(["testorg/otherrepo", "testorg/testrepo", "testorg/thirdrepo"]);
  });
});

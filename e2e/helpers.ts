import type { BrowserContext, Page, Request } from "@playwright/test";
import { resolveGitSha } from "../vite-plugins/build-meta";

type RouteTarget = Page | BrowserContext;

export const CONFIG_KEY = "github-tracker:config";
export const VIEW_KEY = "github-tracker:view";
export const AUTH_TOKEN_KEY = "github-tracker:auth-token";
export const UPDATE_RELOADED_SHA_KEY = "github-tracker:update-reloaded-sha";
export const CHUNK_RELOAD_KEY = "github-tracker:chunk-reload";

/** The running build's 12-character SHA, resolved the same way the build stamps it. */
export const RUNNING_SHA = resolveGitSha();
/** A different 12-character SHA standing in for a newer deployment. */
export const NEWER_SHA = RUNNING_SHA === "111111111111" ? "222222222222" : "111111111111";

const EMPTY_SEARCH = { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
const RATE_LIMIT = { limit: 5000, remaining: 4999, resetAt: "2099-01-01T00:00:00Z" };

export const TEST_USER = {
  login: "testuser",
  name: "Test User",
  avatar_url: "https://github.com/testuser.png",
};

export const TEST_REPO = { owner: "testorg", name: "testrepo", fullName: "testorg/testrepo" };

const DEFAULT_CONFIG = {
  selectedOrgs: ["testorg"],
  selectedRepos: [TEST_REPO],
  onboardingComplete: true,
};

export interface GitHubApiData {
  /** Issue nodes returned by the dashboard's issue search. */
  issues?: Record<string, unknown>[];
  /** Pull request nodes returned by the dashboard's "involves me" PR search. */
  pullRequests?: Record<string, unknown>[];
}

/**
 * Routes every api.github.com request the dashboard makes: the /user check, Actions runs,
 * notifications and the GraphQL searches. Anything else is aborted so a missing mock
 * fails loudly. Registered on a context, the routes apply to every tab in it.
 */
export async function mockGitHubApi(target: RouteTarget, data: GitHubApiData = {}): Promise<void> {
  await target.route("https://api.github.com/**", (route) => route.abort());
  await target.route("https://api.github.com/user", (route) =>
    route.fulfill({ status: 200, json: TEST_USER }),
  );
  await target.route("https://api.github.com/repos/*/*/actions/runs*", (route) =>
    route.fulfill({ status: 200, json: { total_count: 0, workflow_runs: [] } }),
  );
  await target.route("https://api.github.com/notifications*", (route) =>
    route.fulfill({ status: 200, json: [] }),
  );
  const issues = data.issues ?? [];
  const pullRequests = data.pullRequests ?? [];
  await target.route("https://api.github.com/graphql", (route) =>
    route.fulfill({
      status: 200,
      json: {
        data: {
          issues: { ...EMPTY_SEARCH, issueCount: issues.length, nodes: issues },
          prInvolves: { ...EMPTY_SEARCH, issueCount: pullRequests.length, nodes: pullRequests },
          prReviewReq: EMPTY_SEARCH,
          rateLimit: RATE_LIMIT,
        },
      },
    }),
  );
}

/**
 * Register API route interceptors and inject auth + config into localStorage BEFORE navigation.
 * OAuth App uses permanent tokens stored in localStorage — no refresh endpoint needed.
 * The app calls validateToken() on load, which GETs /user to verify the token.
 * The seed is rewritten on every document load; use `seedStorageOnce` for scenarios
 * that reload and must see what the app itself saved.
 */
export async function setupAuth(page: Page, configOverrides?: Record<string, unknown>) {
  await mockGitHubApi(page);

  // Seed localStorage with auth token and config before the page loads
  await page.addInitScript(
    ({ config, tokenKey, configKey }) => {
      localStorage.setItem(tokenKey, "fake-token");
      localStorage.setItem(configKey, JSON.stringify(config));
    },
    { config: { ...DEFAULT_CONFIG, ...configOverrides }, tokenKey: AUTH_TOKEN_KEY, configKey: CONFIG_KEY },
  );
}

/** A syntactically valid classic personal access token (ghp_ + 36 characters). */
export function fakePat(fill: string): string {
  return `ghp_${fill.repeat(36).slice(0, 36)}`;
}

export interface SeedOptions {
  config?: Record<string, unknown>;
  token?: string;
}

/**
 * Seeds the signed-in token and config once per tab: on a tab's first document load, and
 * only when no token is stored yet (a second tab in the same context finds the first
 * tab's data and leaves it alone). Reloads and full navigations then see exactly what
 * the app saved, including a sign-out. This relies on the app never clearing the whole of
 * sessionStorage on sign-out; if it did, the next load would re-seed the token.
 */
export async function seedStorageOnce(target: RouteTarget, options: SeedOptions = {}): Promise<void> {
  await target.addInitScript(
    ({ config, token, tokenKey, configKey }) => {
      const marker = "e2e:storage-seeded";
      if (sessionStorage.getItem(marker) !== null) return;
      sessionStorage.setItem(marker, "1");
      if (localStorage.getItem(tokenKey) !== null) return;
      localStorage.setItem(tokenKey, token);
      localStorage.setItem(configKey, JSON.stringify(config));
    },
    {
      config: { ...DEFAULT_CONFIG, ...options.config },
      token: options.token ?? "fake-token",
      tokenKey: AUTH_TOKEN_KEY,
      configKey: CONFIG_KEY,
    },
  );
}

// ── Dashboard data ───────────────────────────────────────────────────────────

const ISO_RECENT = "2026-11-01T00:00:00Z";

export function makeIssueNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: "Issue",
    databaseId: 1001,
    number: 42,
    title: "Version banner acceptance issue",
    state: "OPEN",
    url: "https://github.com/testorg/testrepo/issues/42",
    createdAt: ISO_RECENT,
    updatedAt: ISO_RECENT,
    author: { login: "testuser" },
    labels: { nodes: [] },
    assignees: { nodes: [] },
    comments: { totalCount: 0 },
    repository: { nameWithOwner: TEST_REPO.fullName, stargazerCount: 5 },
    ...overrides,
  };
}

export function makePullRequestNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: "PullRequest",
    id: "PR_node_1",
    databaseId: 2001,
    number: 7,
    title: "Version banner acceptance pull request",
    state: "OPEN",
    isDraft: false,
    url: "https://github.com/testorg/testrepo/pull/7",
    createdAt: ISO_RECENT,
    updatedAt: ISO_RECENT,
    author: { login: "testuser", avatarUrl: "https://github.com/testuser.png" },
    repository: { nameWithOwner: TEST_REPO.fullName, stargazerCount: 5 },
    headRefName: "feature/acceptance",
    baseRefName: "main",
    reviewDecision: null,
    labels: { nodes: [] },
    ...overrides,
  };
}

// ── /version.json ────────────────────────────────────────────────────────────

export interface DeployedBuild {
  version?: string;
  sha: string;
  schemaFp?: string;
}

/**
 * Serves /version.json for one tab. `current()` is read on every request, so a test can
 * change the deployed build (a rollout or a rollback) between checks.
 */
export async function serveVersionJson(page: Page, current: () => DeployedBuild): Promise<void> {
  await page.route("**/version.json", (route) => {
    const build = current();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: build.version ?? "9.9.9",
        sha: build.sha,
        builtAt: "2026-11-07T00:00:00.000Z",
        ...(build.schemaFp === undefined ? {} : { schemaFp: build.schemaFp }),
      }),
    });
  });
}

/** Runs the update check the way returning to the tab does. */
export async function triggerVersionCheck(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

export function isVersionRequest(request: Request): boolean {
  return new URL(request.url()).pathname === "/version.json";
}

// ── Document loads ───────────────────────────────────────────────────────────

// A property set on `window` survives a client-side route change and is gone after a full
// document load.
type MarkedWindow = Window & { __spaMarker?: boolean };

export async function markWindow(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as MarkedWindow).__spaMarker = true;
  });
}

export async function windowIsMarked(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as MarkedWindow).__spaMarker === true);
}

/** Counts this tab's main-frame document requests (initial load, reloads, full navigations). */
export function countDocumentLoads(page: Page): () => number {
  let count = 0;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) count++;
  });
  return () => count;
}

/** Waits two animation frames so the page has applied whatever its last event changed. */
export async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

// ── Storage ──────────────────────────────────────────────────────────────────

export async function readStoredRaw(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => localStorage.getItem(k), key);
}

export async function readStoredJson(page: Page, key: string): Promise<Record<string, unknown> | null> {
  const raw = await readStoredRaw(page, key);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

// ── Shared locators ──────────────────────────────────────────────────────────

export const updateBanner = (page: Page) =>
  page.getByRole("status").filter({ hasText: "A new version is available." });

export const settingsHeading = (page: Page) => page.getByRole("heading", { name: /^settings$/i });

/** The repo group toggle for the test repo on the active dashboard tab. */
export const repoGroupToggle = (page: Page) =>
  page.locator("button[aria-expanded]").filter({ hasText: TEST_REPO.fullName });

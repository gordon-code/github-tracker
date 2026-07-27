import { test, expect } from "@playwright/test";
import { setupAuth } from "./helpers";

const recentDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const staleDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();

function makeDepPR(overrides: Record<string, unknown> = {}) {
  return {
    __typename: "PullRequest",
    id: "PR_dep_1",
    databaseId: 9001,
    number: 100,
    title: "Bump lodash from 4.17.20 to 4.17.21",
    state: "OPEN",
    isDraft: false,
    url: "https://github.com/testorg/testrepo/pull/100",
    createdAt: recentDate,
    updatedAt: recentDate,
    author: { login: "renovate[bot]", avatarUrl: "https://avatars.githubusercontent.com/in/2740" },
    repository: { nameWithOwner: "testorg/testrepo", stargazerCount: 10 },
    headRefName: "renovate/lodash-4.x",
    baseRefName: "main",
    reviewDecision: null,
    labels: { nodes: [] },
    ...overrides,
  };
}

function graphqlWithDepPRs(prs: Record<string, unknown>[], issues: Record<string, unknown>[] = []) {
  return {
    data: {
      issues: { issueCount: issues.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: issues },
      prInvolves: {
        issueCount: prs.length,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: prs,
      },
      prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      rateLimit: { limit: 5000, remaining: 4999, resetAt: "2099-01-01T00:00:00Z" },
    },
  };
}

function makeDashboardIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue_dashboard_1",
    databaseId: 5001,
    number: 1,
    title: "Dependency Dashboard",
    state: "OPEN",
    url: "https://github.com/testorg/testrepo/issues/1",
    createdAt: recentDate,
    updatedAt: recentDate,
    author: { login: "renovate[bot]", avatarUrl: "https://avatars.githubusercontent.com/in/2740" },
    labels: { nodes: [] },
    assignees: { nodes: [] },
    comments: { totalCount: 0 },
    repository: { nameWithOwner: "testorg/testrepo", stargazerCount: 10 },
    ...overrides,
  };
}

const ABANDONED_LODASH_BODY = `## Abandoned

| Datasource | Package | Last Updated |
| --- | --- | --- |
| npm | lodash | 2025-01-01 |
`;

/**
 * Registers a single /graphql handler that serves the light combined search response for
 * every call EXCEPT the dashboard-issue-body follow-up query, which it detects by inspecting
 * the GraphQL query text itself — not `variables.request?.apiSource`. That field is consumed
 * internally by @octokit/graphql as reserved request-config (used only for the app's own
 * analytics hook, see github.ts) and never reaches the serialized wire body. Both
 * DASHBOARD_ISSUE_BODIES_QUERY and DEP_PR_BODIES_QUERY (and the heavy PR backfill/enrichment
 * query) share the same `$ids` variable name, so `"ids" in variables` alone can't disambiguate
 * them either — the query string's selection set (`... on Issue { id body }`, unique to the
 * dashboard-body query) is the only reliable signal, confirmed by inspecting the actual
 * serialized request bodies at runtime.
 */
async function mockGraphqlWithDashboardBody(
  page: import("@playwright/test").Page,
  prs: Record<string, unknown>[],
  issues: Record<string, unknown>[],
  dashboardIssueId: string,
  dashboardBody: string
) {
  await page.route("https://api.github.com/graphql", (route) => {
    const parsed = route.request().postDataJSON() as { query?: string } | null;
    const query = parsed?.query ?? "";
    if (query.includes("on Issue { id body }")) {
      return route.fulfill({
        status: 200,
        json: {
          data: {
            nodes: [{ id: dashboardIssueId, body: dashboardBody }],
            rateLimit: { limit: 5000, remaining: 4999, resetAt: "2099-01-01T00:00:00Z" },
          },
        },
      });
    }
    return route.fulfill({ status: 200, json: graphqlWithDepPRs(prs, issues) });
  });
}

// ── Dependencies tab visibility ─────────────────────────────────────────────

test("dependencies tab auto-appears when dep bot PRs exist", async ({ page }) => {
  await setupAuth(page);
  await page.route("https://api.github.com/graphql", (route) =>
    route.fulfill({ status: 200, json: graphqlWithDepPRs([makeDepPR()]) })
  );
  await page.goto("/dashboard");
  await page.getByRole("tablist").waitFor();

  await expect(page.getByRole("tab", { name: /dependencies/i })).toBeVisible({ timeout: 10_000 });
});

test("dependencies tab is absent when no dep PRs exist", async ({ page }) => {
  await setupAuth(page);
  await page.goto("/dashboard");

  await expect(page.getByRole("tab", { name: /dependencies/i })).toHaveCount(0);
});

test("settings toggle hides the dependencies tab", async ({ page }) => {
  await setupAuth(page, { dependencies: { enabled: false, rebaseLabel: "rebase" } });
  await page.route("https://api.github.com/graphql", (route) =>
    route.fulfill({ status: 200, json: graphqlWithDepPRs([makeDepPR()]) })
  );
  await page.goto("/dashboard");

  await expect(page.getByRole("tab", { name: /dependencies/i })).toHaveCount(0);
});

// ── Bot-detection signal isolation ──────────────────────────────────────────

test("author-login-only detection: dependabot[bot] PR appears in Dependencies, not Pull Requests", async ({ page }) => {
  const pr = makeDepPR({
    author: { login: "dependabot[bot]", avatarUrl: "https://avatars.githubusercontent.com/in/2740" },
    headRefName: "some-unrelated-branch",
    title: "Fix something unrelated",
    labels: { nodes: [] },
  });

  await setupAuth(page);
  await page.route("https://api.github.com/graphql", (route) =>
    route.fulfill({ status: 200, json: graphqlWithDepPRs([pr]) })
  );
  await page.goto("/dashboard");

  await expect(page.getByRole("tab", { name: /dependencies/i })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("tab", { name: /dependencies/i }).click();
  // Only the "mergeable" status group is expanded by default; these light, recent
  // PRs land in "Needs Action" (collapsed), so expand all groups before asserting.
  await page.getByLabel("Expand all repos").click();
  await expect(page.getByText(pr.title)).toBeVisible();

  await page.getByRole("tab", { name: /pull requests/i }).click();
  await expect(page.getByText(pr.title)).toHaveCount(0);
});

test("branch-prefix-only detection: renovate/ branch PR appears in Dependencies, not Pull Requests", async ({ page }) => {
  const pr = makeDepPR({
    author: { login: "some-human" },
    headRefName: "renovate/foo-1.x",
    title: "Fix something unrelated",
    labels: { nodes: [] },
  });

  await setupAuth(page);
  await page.route("https://api.github.com/graphql", (route) =>
    route.fulfill({ status: 200, json: graphqlWithDepPRs([pr]) })
  );
  await page.goto("/dashboard");

  await expect(page.getByRole("tab", { name: /dependencies/i })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("tab", { name: /dependencies/i }).click();
  // Only the "mergeable" status group is expanded by default; these light, recent
  // PRs land in "Needs Action" (collapsed), so expand all groups before asserting.
  await page.getByLabel("Expand all repos").click();
  await expect(page.getByText(pr.title)).toBeVisible();

  await page.getByRole("tab", { name: /pull requests/i }).click();
  await expect(page.getByText(pr.title)).toHaveCount(0);
});

test("label-only detection: dependencies-labeled PR appears in Dependencies, not Pull Requests", async ({ page }) => {
  const pr = makeDepPR({
    author: { login: "some-human" },
    headRefName: "some-feature",
    title: "Fix something unrelated",
    labels: { nodes: [{ name: "dependencies" }] },
  });

  await setupAuth(page);
  await page.route("https://api.github.com/graphql", (route) =>
    route.fulfill({ status: 200, json: graphqlWithDepPRs([pr]) })
  );
  await page.goto("/dashboard");

  await expect(page.getByRole("tab", { name: /dependencies/i })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("tab", { name: /dependencies/i }).click();
  // Only the "mergeable" status group is expanded by default; these light, recent
  // PRs land in "Needs Action" (collapsed), so expand all groups before asserting.
  await page.getByLabel("Expand all repos").click();
  await expect(page.getByText(pr.title)).toBeVisible();

  await page.getByRole("tab", { name: /pull requests/i }).click();
  await expect(page.getByText(pr.title)).toHaveCount(0);
});

// ── Status groups ───────────────────────────────────────────────────────────

test("status groups render correctly", async ({ page }) => {
  // Light PRs lack enrichment data, so recent ones land in "Needs Action" and old ones in "Stale"
  const waitingPR = makeDepPR({
    id: "PR_wait_1",
    databaseId: 9002,
    number: 101,
    title: "Bump axios from 0.27.2 to 1.0.0",
  });
  const stalePR = makeDepPR({
    id: "PR_stale_1",
    databaseId: 9003,
    number: 102,
    title: "Bump react from 17.0.0 to 18.0.0",
    updatedAt: staleDate,
    createdAt: staleDate,
  });

  await setupAuth(page);
  await page.route("https://api.github.com/graphql", (route) =>
    route.fulfill({ status: 200, json: graphqlWithDepPRs([waitingPR, stalePR]) })
  );
  await page.goto("/dashboard");

  // Switch to Dependencies tab
  await page.getByRole("tab", { name: /dependencies/i }).click();

  // Both status groups should appear
  await expect(page.getByText("Needs Action")).toBeVisible();
  await expect(page.getByText("Stale")).toBeVisible();
});

// ── Abandoned-dependency pill ────────────────────────────────────────────────

test("abandoned dep badge links to the Dependency Dashboard issue when matched", async ({ page }) => {
  const dashboardIssue = makeDashboardIssue();
  // makeDepPR()'s default title is "Bump lodash from 4.17.20 to 4.17.21" — matches
  // the "lodash" row in ABANDONED_LODASH_BODY via matchAbandonedToPr()'s substring match.
  const pr = makeDepPR();

  await setupAuth(page);
  await mockGraphqlWithDashboardBody(page, [pr], [dashboardIssue], dashboardIssue.id, ABANDONED_LODASH_BODY);
  await page.goto("/dashboard");

  await expect(page.getByRole("tab", { name: /dependencies/i })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("tab", { name: /dependencies/i }).click();
  await page.getByLabel("Expand all repos").click();

  // The dashboard-issue-body follow-up query only fires after the first full poll
  // completes, so the badge starts as absent/plain-text and becomes a link asynchronously.
  const abandonedLink = page.getByRole("link", { name: /abandoned/i });
  await expect(abandonedLink).toBeVisible({ timeout: 10_000 });
  await expect(abandonedLink).toHaveAttribute("href", dashboardIssue.url);
});

test("abandoned dep badge renders as plain text when title-suffix heuristic matches with no dashboard issue", async ({ page }) => {
  const pr = makeDepPR({
    title: "Bump left-pad from 1.0.0 to 1.0.1 - abandoned",
  });

  await setupAuth(page);
  await page.route("https://api.github.com/graphql", (route) =>
    route.fulfill({ status: 200, json: graphqlWithDepPRs([pr]) })
  );
  await page.goto("/dashboard");

  await expect(page.getByRole("tab", { name: /dependencies/i })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("tab", { name: /dependencies/i }).click();
  await page.getByLabel("Expand all repos").click();

  await expect(page.getByText("Abandoned")).toBeVisible();
  await expect(page.getByRole("link", { name: /abandoned/i })).toHaveCount(0);
});

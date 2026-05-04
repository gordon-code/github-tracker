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

function graphqlWithDepPRs(prs: Record<string, unknown>[]) {
  return {
    data: {
      issues: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
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

// ── Dependencies tab visibility ─────────────────────────────────────────────

test("dependencies tab auto-appears when dep bot PRs exist", async ({ page }) => {
  await setupAuth(page);
  await page.route("https://api.github.com/graphql", (route) =>
    route.fulfill({ status: 200, json: graphqlWithDepPRs([makeDepPR()]) })
  );
  await page.goto("/dashboard");

  await expect(page.getByRole("tab", { name: /dependencies/i })).toBeVisible();
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

// ── Status groups ───────────────────────────────────────────────────────────

test("status groups render correctly", async ({ page }) => {
  // Light PRs have enriched=false, so recent ones land in "Waiting" and old ones in "Stale"
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

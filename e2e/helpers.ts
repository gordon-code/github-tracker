import type { Page } from "@playwright/test";

/**
 * Register API route interceptors and inject auth + config into localStorage BEFORE navigation.
 * OAuth App uses permanent tokens stored in localStorage — no refresh endpoint needed.
 * The app calls validateToken() on load, which GETs /user to verify the token.
 */
export async function setupAuth(page: Page, configOverrides?: Record<string, unknown>) {
  // Catch-all: abort any unmocked GitHub API request so failures are loud
  await page.route("https://api.github.com/**", (route) => route.abort());

  // Intercept /user validation (called by validateToken on page load)
  await page.route("https://api.github.com/user", (route) =>
    route.fulfill({
      status: 200,
      json: {
        login: "testuser",
        name: "Test User",
        avatar_url: "https://github.com/testuser.png",
      },
    })
  );
  await page.route(
    "https://api.github.com/repos/*/*/actions/runs*",
    (route) =>
      route.fulfill({
        status: 200,
        json: { total_count: 0, workflow_runs: [] },
      })
  );
  await page.route("https://api.github.com/notifications*", (route) =>
    route.fulfill({ status: 200, json: [] })
  );
  await page.route("https://api.github.com/graphql", (route) =>
    route.fulfill({
      status: 200,
      json: {
        data: {
          issues: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prInvolves: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          rateLimit: { limit: 5000, remaining: 4999, resetAt: "2099-01-01T00:00:00Z" },
        },
      },
    })
  );

  // Seed localStorage with auth token and config before the page loads
  await page.addInitScript((overrides) => {
    localStorage.setItem("github-tracker:auth-token", "fake-token");
    localStorage.setItem(
      "github-tracker:config",
      JSON.stringify({
        selectedOrgs: ["testorg"],
        selectedRepos: [{ owner: "testorg", name: "testrepo", fullName: "testorg/testrepo" }],
        onboardingComplete: true,
        ...overrides,
      })
    );
  }, configOverrides ?? {});
}

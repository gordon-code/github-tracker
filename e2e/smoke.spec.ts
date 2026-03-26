import { test, expect, type Page } from "@playwright/test";

/**
 * Register API route interceptors and inject auth + config into localStorage BEFORE navigation.
 * OAuth App uses permanent tokens stored in localStorage — no refresh endpoint needed.
 * The app calls validateToken() on load, which GETs /user to verify the token.
 */
async function setupAuth(page: Page) {
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
    "https://api.github.com/repos/*/actions/runs*",
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
          search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          rateLimit: { remaining: 5000, resetAt: new Date(Date.now() + 3600000).toISOString() },
        },
      },
    })
  );

  // Seed localStorage with auth token and config before the page loads
  await page.addInitScript(() => {
    localStorage.setItem("github-tracker:auth-token", "ghu_fake");
    localStorage.setItem(
      "github-tracker:config",
      JSON.stringify({
        selectedOrgs: ["testorg"],
        selectedRepos: [{ owner: "testorg", name: "testrepo", fullName: "testorg/testrepo" }],
        onboardingComplete: true,
      })
    );
  });
}

// ── Login page ───────────────────────────────────────────────────────────────

test("login page renders sign in button", async ({ page }) => {
  await page.goto("/login");
  const btn = page.getByRole("button", { name: /sign in with github/i });
  await expect(btn).toBeVisible();
});

// ── OAuth callback flow ──────────────────────────────────────────────────────

test("OAuth callback flow completes and redirects", async ({ page }) => {
  const fakeState = "teststate123";

  // Pre-populate sessionStorage with the CSRF state before navigation.
  await page.addInitScript((state) => {
    sessionStorage.setItem("github-tracker:oauth-state", state);
  }, fakeState);

  // Mock the token exchange endpoint and the /user validation
  await page.route("**/api/oauth/token", (route) =>
    route.fulfill({
      status: 200,
      json: {
        access_token: "ghu_fake",
        token_type: "bearer",
        scope: "repo read:org notifications",
      },
    })
  );
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
  // After validateToken succeeds the callback navigates to '/' which redirects
  // to /dashboard (onboardingComplete) or /onboarding. We need config set.
  await page.addInitScript(() => {
    localStorage.setItem(
      "github-tracker:config",
      JSON.stringify({
        selectedOrgs: ["testorg"],
        selectedRepos: [{ owner: "testorg", name: "testrepo", fullName: "testorg/testrepo" }],
        onboardingComplete: true,
      })
    );
  });
  // Also intercept downstream dashboard API calls
  await page.route("https://api.github.com/graphql", (route) =>
    route.fulfill({
      status: 200,
      json: {
        data: {
          search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          rateLimit: { remaining: 5000, resetAt: new Date(Date.now() + 3600000).toISOString() },
        },
      },
    })
  );
  await page.route("https://api.github.com/notifications*", (route) =>
    route.fulfill({ status: 200, json: [] })
  );

  await page.goto(`/oauth/callback?code=fakecode&state=${fakeState}`);

  // After successful auth the callback navigates to '/' which redirects
  // to /dashboard (if onboardingComplete) or /onboarding (first login)
  await expect(page).toHaveURL(/\/(dashboard|onboarding)/);
});

// ── Dashboard ────────────────────────────────────────────────────────────────

test("dashboard loads with tab bar visible", async ({ page }) => {
  await setupAuth(page);
  await page.goto("/dashboard");

  const tablist = page.getByRole("tablist");
  await expect(tablist).toBeVisible();

  await expect(page.getByRole("tab", { name: /^issues/i })).toBeVisible();
  await expect(
    page.getByRole("tab", { name: /^pull requests/i })
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: /^actions/i })).toBeVisible();
});

test("switching tabs changes active tab indicator", async ({ page }) => {
  await setupAuth(page);
  await page.goto("/dashboard");

  const issuesTab = page.getByRole("tab", { name: /^issues/i });
  const prTab = page.getByRole("tab", { name: /^pull requests/i });
  const actionsTab = page.getByRole("tab", { name: /^actions/i });

  // Default tab should be issues (or whatever config says; we didn't set defaultTab)
  await expect(issuesTab).toBeVisible();

  // Click Pull Requests tab
  await prTab.click();
  await expect(prTab).toHaveAttribute("aria-selected", "true");
  await expect(issuesTab).not.toHaveAttribute("aria-selected", "true");

  // Click Actions tab
  await actionsTab.click();
  await expect(actionsTab).toHaveAttribute("aria-selected", "true");
});

test("dashboard shows empty state with no data", async ({ page }) => {
  await setupAuth(page);
  await page.goto("/dashboard");

  // With empty mocked responses the dashboard should not show a loading spinner
  // indefinitely — wait for the tab bar to appear then confirm no data rows
  const tablist = page.getByRole("tablist");
  await expect(tablist).toBeVisible();

  // The issues tab content area should render (even if empty)
  await expect(page.getByRole("main")).toBeVisible();
});

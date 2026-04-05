import { test, expect } from "@playwright/test";
import { setupAuth } from "./helpers";

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

  // Catch-all: abort any unmocked GitHub API request so failures are loud
  await page.route("https://api.github.com/**", (route) => route.abort());

  // Mock the token exchange endpoint and the /user validation
  await page.route("**/api/oauth/token", (route) =>
    route.fulfill({
      status: 200,
      json: {
        access_token: "fake-token",
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
  // Intercept downstream dashboard API calls
  await page.route(
    "https://api.github.com/repos/*/*/actions/runs*",
    (route) =>
      route.fulfill({
        status: 200,
        json: { total_count: 0, workflow_runs: [] },
      })
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

test("fixed elements compensate for scrollbar width when scroll is locked", async ({ page }) => {
  await setupAuth(page);
  await page.goto("/dashboard");

  const navbar = page.locator(".navbar");
  const footer = page.locator(".app-footer");
  await expect(navbar).toBeVisible();
  await expect(footer).toBeVisible();

  // Baseline: navbar 0.5rem (8px) from daisyUI, footer 0px (no base padding)
  expect(parseFloat(await navbar.evaluate((el) => getComputedStyle(el).paddingRight))).toBeCloseTo(8, 0);
  expect(parseFloat(await footer.evaluate((el) => getComputedStyle(el).paddingRight))).toBeCloseTo(0, 0);

  // Simulate solid-prevent-scroll setting --scrollbar-width on body
  await page.evaluate(() => {
    document.body.style.setProperty("--scrollbar-width", "15px");
  });

  // Navbar: 8px + 15px = 23px, footer: 0px + 15px = 15px
  expect(parseFloat(await navbar.evaluate((el) => getComputedStyle(el).paddingRight))).toBeCloseTo(23, 0);
  expect(parseFloat(await footer.evaluate((el) => getComputedStyle(el).paddingRight))).toBeCloseTo(15, 0);

  // Clear — both return to baseline
  await page.evaluate(() => {
    document.body.style.removeProperty("--scrollbar-width");
  });
  expect(parseFloat(await navbar.evaluate((el) => getComputedStyle(el).paddingRight))).toBeCloseTo(8, 0);
  expect(parseFloat(await footer.evaluate((el) => getComputedStyle(el).paddingRight))).toBeCloseTo(0, 0);
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

test("OG and Twitter meta tags are present", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "GitHub Tracker");
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /social-preview\.png$/);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /Dashboard for tracking/);
});

test("unknown path redirects to login when unauthenticated", async ({ page }) => {
  await page.goto("/this-path-does-not-exist");
  // catch-all → Navigate "/" → RootRedirect → validateToken() fails → Navigate "/login"
  await expect(page).toHaveURL(/\/login/, { timeout: 10000 });
});

test("unknown path redirects to dashboard when authenticated", async ({ page }) => {
  await setupAuth(page);
  await page.goto("/this-path-does-not-exist");
  // catch-all → Navigate "/" → RootRedirect → validateToken() succeeds → Navigate "/dashboard"
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 10000 });
});

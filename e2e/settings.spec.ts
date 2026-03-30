import { test, expect, type Page } from "@playwright/test";

/**
 * Register API route interceptors and inject auth + config into localStorage BEFORE navigation.
 * OAuth App uses permanent tokens stored in localStorage — no refresh endpoint needed.
 * The app calls validateToken() on load, which GETs /user to verify the token.
 */
async function setupAuth(page: Page) {
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
  await page.route("https://api.github.com/notifications*", (route) =>
    route.fulfill({ status: 200, json: [] })
  );
  await page.route("https://api.github.com/graphql", (route) =>
    route.fulfill({
      status: 200,
      json: {
        data: {
          search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          rateLimit: { limit: 5000, remaining: 5000, resetAt: new Date(Date.now() + 3600000).toISOString() },
        },
      },
    })
  );

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

// ── Settings page renders ────────────────────────────────────────────────────

test("settings page renders section headings", async ({ page }) => {
  await setupAuth(page);
  await page.goto("/settings");

  await expect(
    page.getByRole("heading", { name: /organizations & repositories/i })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /appearance/i })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /notifications/i })
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: /data/i })).toBeVisible();
});

test("settings page has main heading", async ({ page }) => {
  await setupAuth(page);
  await page.goto("/settings");

  await expect(
    page.getByRole("heading", { name: /^settings$/i })
  ).toBeVisible();
});

// ── Back to dashboard ────────────────────────────────────────────────────────

test("back link navigates to dashboard", async ({ page }) => {
  await setupAuth(page);
  await page.goto("/settings");

  // The back arrow link has aria-label="Back to dashboard"
  const backLink = page.getByRole("link", { name: /back to dashboard/i });
  await expect(backLink).toBeVisible();
  await backLink.click();

  await expect(page).toHaveURL(/\/dashboard/);
});

// ── Theme change ─────────────────────────────────────────────────────────────

test("changing theme to dark applies data-theme attribute", async ({
  page,
}) => {
  await setupAuth(page);
  await page.goto("/settings");

  // ThemePicker uses buttons with aria-label "Theme: <name>"
  const darkBtn = page.getByRole("button", { name: "Theme: dark" });
  await darkBtn.click();

  const htmlElement = page.locator("html");
  await expect(htmlElement).toHaveAttribute("data-theme", "dark");
});

// ── Sign out ─────────────────────────────────────────────────────────────────

test("sign out clears auth and redirects to login", async ({ page }) => {
  await setupAuth(page);
  await page.goto("/settings");

  // The sign out button is inside the "Data" section
  const signOutBtn = page.getByRole("button", { name: /^sign out$/i });
  await expect(signOutBtn).toBeVisible();

  await signOutBtn.click();

  // clearAuth() removes the localStorage token and navigates to /login
  await expect(page).toHaveURL(/\/login/);

  // Verify auth token was cleared from localStorage
  const authToken = await page.evaluate(() =>
    localStorage.getItem("github-tracker:auth-token")
  );
  expect(authToken).toBeNull();

  // Verify config was reset (SDR-016 data leakage prevention).
  // The persistence effect may re-write defaults, so check that user-specific
  // data (selectedOrgs, onboardingComplete) was cleared rather than checking null.
  const configEntry = await page.evaluate(() =>
    localStorage.getItem("github-tracker:config")
  );
  if (configEntry !== null) {
    const parsed = JSON.parse(configEntry);
    expect(parsed.selectedOrgs).toEqual([]);
    expect(parsed.onboardingComplete).toBe(false);
  }
});

import { test, expect, type Page } from "@playwright/test";

/**
 * Register API route interceptors and inject config BEFORE any navigation.
 * The app calls refreshAccessToken() on load, which POSTs to /api/oauth/refresh
 * (HttpOnly cookie-based). We intercept that to return a valid access token.
 */
async function setupAuth(page: Page) {
  await page.route("**/api/oauth/refresh", (route) =>
    route.fulfill({
      status: 200,
      json: { access_token: "ghu_fake", expires_in: 86400 },
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
  await page.route("https://api.github.com/search/issues*", (route) =>
    route.fulfill({
      status: 200,
      json: { total_count: 0, incomplete_results: false, items: [] },
    })
  );
  await page.route("https://api.github.com/notifications*", (route) =>
    route.fulfill({ status: 200, json: [] })
  );
  await page.route("https://api.github.com/graphql", (route) =>
    route.fulfill({ status: 200, json: { data: {} } })
  );

  await page.addInitScript(() => {
    localStorage.setItem(
      "github-tracker:config",
      JSON.stringify({
        selectedOrgs: ["testorg"],
        selectedRepos: [{ owner: "testorg", name: "testrepo" }],
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

test("changing theme to dark adds dark class to html element", async ({
  page,
}) => {
  await setupAuth(page);
  await page.goto("/settings");

  // Locate the Theme setting row by its label text, then find its <select> child.
  const themeSelect = page.getByRole("combobox").filter({ has: page.locator('option[value="dark"]') });
  await themeSelect.selectOption("dark");

  const htmlElement = page.locator("html");
  await expect(htmlElement).toHaveClass(/dark/);
});

// ── Sign out ─────────────────────────────────────────────────────────────────

test("sign out clears auth and redirects to login", async ({ page }) => {
  await setupAuth(page);
  await page.goto("/settings");

  // The sign out button is inside the "Data" section
  const signOutBtn = page.getByRole("button", { name: /^sign out$/i });
  await expect(signOutBtn).toBeVisible();

  // Intercept the logout cookie-clearing request
  await page.route("**/api/oauth/logout", (route) =>
    route.fulfill({ status: 200, json: { ok: true } })
  );

  await signOutBtn.click();

  // clearAuth() clears in-memory token and navigates to /login
  await expect(page).toHaveURL(/\/login/);

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

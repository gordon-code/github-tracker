import { test, expect, type Page } from "@playwright/test";

/**
 * Inject auth + config before navigation. Navigating to /settings hits
 * RootRedirect first (via /) which calls validateToken() — the /user
 * interceptor MUST be registered before any navigation.
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
      "github-tracker:auth",
      JSON.stringify({
        accessToken: "ghu_fake",
        refreshToken: "ghr_fake",
        expiresAt: Date.now() + 86400000,
      })
    );
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

  // Select the theme dropdown within the Appearance section.
  // The Select component renders a <select> whose current value matches config.theme.
  // We select "dark" to trigger applyTheme('dark') which adds class="dark" to <html>.
  const themeSelect = page.locator("select").filter({ hasText: /system|light|dark/i }).first();
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
  await signOutBtn.click();

  // clearAuth() removes localStorage entry and navigates to /login
  await expect(page).toHaveURL(/\/login/);

  // Verify auth token was cleared from localStorage
  const authEntry = await page.evaluate(() =>
    localStorage.getItem("github-tracker:auth")
  );
  expect(authEntry).toBeNull();
});

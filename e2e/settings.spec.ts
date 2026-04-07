import { test, expect } from "@playwright/test";
import { setupAuth } from "./helpers";

// ── Settings page renders ────────────────────────────────────────────────────

test("settings page renders section headings", async ({ page }) => {
  await setupAuth(page);
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");

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

import { test, expect, type Page } from "@playwright/test";
import { setupAuth } from "./helpers";

const emptyGraphqlFixture = {
  data: {
    issues: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    prInvolves: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    rateLimit: { limit: 5000, remaining: 4999, resetAt: "2099-01-01T00:00:00Z" },
  },
};

/**
 * Fakes a real GitHub primary-rate-limit response on the FIRST /graphql POST so
 * @octokit/plugin-throttling's onRateLimit handler fires (github.ts:86-98), which calls
 * pushNotification("rate-limit", ..., "warning", true). The plugin then auto-retries
 * once internally (retryCount < 1 => true); the SECOND POST returns normal fixture data
 * so the dashboard loads successfully afterward.
 */
async function triggerRateLimitOnFirstGraphqlCall(page: Page) {
  let callCount = 0;
  await page.route("https://api.github.com/graphql", (route) => {
    callCount += 1;
    if (callCount === 1) {
      const resetEpochSeconds = Math.floor(Date.now() / 1000) + 1;
      return route.fulfill({
        status: 403,
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetEpochSeconds),
          // Cross-origin fetch() only exposes safelisted response headers to JS unless the
          // server opts in via Access-Control-Expose-Headers (the real GitHub API does this) —
          // without it, @octokit/plugin-throttling can't see x-ratelimit-remaining and never
          // fires onRateLimit; the request just fails and surfaces as a generic api error instead.
          "access-control-expose-headers": "x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset",
        },
        json: { message: "API rate limit exceeded for token." },
      });
    }
    return route.fulfill({ status: 200, json: emptyGraphqlFixture });
  });
}

async function openDrawerFromBell(page: Page) {
  await page.goto("/dashboard");

  const bell = page.getByRole("button", { name: /Notifications, \d+ unread/i });
  await expect(bell).toBeVisible({ timeout: 15_000 });
  await bell.click();

  const overlay = page.getByTestId("notification-overlay");
  await expect(overlay).toBeVisible();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // ToastContainer renders the same notification as a toast concurrently (expected,
  // per Task 7 plan) — scope to the dialog to avoid a strict-mode double match.
  await expect(dialog.getByText(/Rate limit hit/i)).toBeVisible();
  return overlay;
}

// ── Open/close animation via real rate-limit-triggered notification ─────────

test("rate-limit notification opens the drawer and Escape closes it", async ({ page }) => {
  await setupAuth(page);
  await triggerRateLimitOnFirstGraphqlCall(page);

  const overlay = await openDrawerFromBell(page);

  await page.keyboard.press("Escape");
  await expect(overlay).toBeHidden();
});

test("rate-limit notification opens the drawer and the close button closes it", async ({ page }) => {
  await setupAuth(page);
  await triggerRateLimitOnFirstGraphqlCall(page);

  const overlay = await openDrawerFromBell(page);

  await page.getByLabel("Close notifications").click();
  await expect(overlay).toBeHidden();
});

// ── prefers-reduced-motion ───────────────────────────────────────────────────

test("drawer still opens and closes correctly under prefers-reduced-motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setupAuth(page);
  await triggerRateLimitOnFirstGraphqlCall(page);

  const overlay = await openDrawerFromBell(page);

  // Under prefers-reduced-motion, index.css disables the drawer keyframe animation
  // entirely (`.drawer-overlay[data-expanded] { animation: none }`), unlike the
  // normal `overlay-fade-in` animation applied without the media query match.
  await expect(overlay).toHaveCSS("animation-name", "none");

  await page.getByLabel("Close notifications").click();
  await expect(overlay).toBeHidden();
});

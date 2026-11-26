import { test, expect, type Page, type Request } from "@playwright/test";
import { setupAuth } from "./helpers";

const USER_URL = "https://api.github.com/user";
const testUser = { login: "testuser", name: "Test User", avatar_url: "https://github.com/testuser.png" };

/**
 * Auth token checks send `X-GitHub-Api-Version`; the dashboard's own Octokit `GET /user` (org
 * discovery) does not, so it is excluded from the count.
 */
function isAuthUserCheck(req: Request): boolean {
  return req.url() === USER_URL && req.headers()["x-github-api-version"] !== undefined;
}

/** Records auth checks and whether the lazy 401 verifier module was requested. */
function trackRequests(page: Page) {
  let userChecks = 0;
  const urls: string[] = [];
  page.on("request", (req: Request) => {
    urls.push(req.url());
    if (isAuthUserCheck(req)) userChecks++;
  });
  return {
    userChecks: () => userChecks,
    loadedVerifier: () => urls.some((u) => /\/auth-401[.-]/.test(u)),
  };
}

async function stubStatusPage(page: Page) {
  await page.route("https://www.githubstatus.com/**", (route) =>
    route.fulfill({ status: 200, json: { components: [], incidents: [], status: { indicator: "none" } } })
  );
}

test("healthy boot makes one GET /user and never loads the 401 verifier", async ({ page }) => {
  await setupAuth(page);
  await stubStatusPage(page);
  const seen = trackRequests(page);

  await page.goto("/dashboard");
  await expect(page.getByRole("tablist")).toBeVisible();

  expect(seen.userChecks()).toBe(1);
  expect(seen.loadedVerifier()).toBe(false);
});

test("a transient boot 401 is retried and the session survives", async ({ page }) => {
  await setupAuth(page);
  await stubStatusPage(page);
  let calls = 0;
  await page.route(USER_URL, (route) => {
    if (!isAuthUserCheck(route.request())) return route.fulfill({ status: 200, json: testUser });
    calls++;
    return calls === 1
      ? route.fulfill({ status: 401, json: { message: "Bad credentials" } })
      : route.fulfill({ status: 200, json: testUser });
  });

  await page.goto("/dashboard");
  await expect(page.getByRole("tablist")).toBeVisible({ timeout: 10_000 });
  await expect(page).toHaveURL(/\/dashboard/);
  expect(calls).toBe(2);
  expect(await page.evaluate(() => localStorage.getItem("github-tracker:auth-token"))).toBe("fake-token");
});

test("a transient runtime GraphQL 401 is verified and the user stays on the dashboard", async ({ page }) => {
  await setupAuth(page);
  await stubStatusPage(page);
  const seen = trackRequests(page);
  let graphqlCalls = 0;
  await page.route("https://api.github.com/graphql", (route) => {
    graphqlCalls++;
    if (graphqlCalls === 1) return route.fulfill({ status: 401, json: { message: "Bad credentials" } });
    return route.fulfill({
      status: 200,
      json: {
        data: {
          issues: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prInvolves: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          rateLimit: { limit: 5000, remaining: 4999, resetAt: "2099-01-01T00:00:00Z" },
        },
      },
    });
  });

  await page.goto("/dashboard");
  await expect(page.getByRole("tablist")).toBeVisible();
  // Verification loads the lazy verifier, waits 1s, and re-checks GET /user (200 → preserved).
  await expect.poll(() => seen.userChecks(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

  expect(seen.loadedVerifier()).toBe(true);
  await expect(page).toHaveURL(/\/dashboard/);
  expect(await page.evaluate(() => localStorage.getItem("github-tracker:auth-token"))).toBe("fake-token");
});

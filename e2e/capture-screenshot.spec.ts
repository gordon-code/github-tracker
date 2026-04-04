import { test } from "@playwright/test";

const RESET_AT = new Date(Date.now() + 3600_000).toISOString();

// ── Synthetic data ────────────────────────────────────────────────────────────

// GraphQL node IDs are base64-encoded strings like "PR_kgDOBsomeId"
const lightPRNodes = [
  {
    id: "PR_kgDOBcAcmeCorp001",
    databaseId: 100001,
    number: 247,
    title: "feat: migrate authentication to passkey support",
    state: "OPEN",
    isDraft: false,
    url: "https://github.com/acme-corp/web-platform/pull/247",
    createdAt: "2026-03-28T09:15:00Z",
    updatedAt: "2026-04-03T10:30:00Z",
    author: { login: "jdoe", avatarUrl: "https://avatars.githubusercontent.com/u/12345?v=4" },
    repository: { nameWithOwner: "acme-corp/web-platform", stargazerCount: 1842 },
    headRefName: "feat/passkey-auth",
    baseRefName: "main",
    reviewDecision: "APPROVED",
    labels: { nodes: [{ name: "feature", color: "0075ca" }, { name: "security", color: "e4e669" }] },
  },
  {
    id: "PR_kgDOBcAcmeCorp002",
    databaseId: 100002,
    number: 312,
    title: "fix: resolve N+1 query in user profile endpoint",
    state: "OPEN",
    isDraft: false,
    url: "https://github.com/acme-corp/api-gateway/pull/312",
    createdAt: "2026-04-01T14:20:00Z",
    updatedAt: "2026-04-03T08:45:00Z",
    author: { login: "msmith", avatarUrl: "https://avatars.githubusercontent.com/u/67890?v=4" },
    repository: { nameWithOwner: "acme-corp/api-gateway", stargazerCount: 573 },
    headRefName: "fix/n-plus-one-profile",
    baseRefName: "main",
    reviewDecision: "CHANGES_REQUESTED",
    labels: { nodes: [{ name: "bug", color: "d73a4a" }, { name: "performance", color: "fef2c0" }] },
  },
  {
    id: "PR_kgDOBcAcmeCorp003",
    databaseId: 100003,
    number: 89,
    title: "chore: update design token naming to match Figma variables",
    state: "OPEN",
    isDraft: true,
    url: "https://github.com/acme-corp/design-system/pull/89",
    createdAt: "2026-04-02T11:00:00Z",
    updatedAt: "2026-04-03T09:00:00Z",
    author: { login: "jdoe", avatarUrl: "https://avatars.githubusercontent.com/u/12345?v=4" },
    repository: { nameWithOwner: "acme-corp/design-system", stargazerCount: 228 },
    headRefName: "chore/design-token-rename",
    baseRefName: "main",
    reviewDecision: "REVIEW_REQUIRED",
    labels: { nodes: [{ name: "design", color: "bfd4f2" }] },
  },
  {
    id: "PR_kgDOBJdoe004",
    databaseId: 100004,
    number: 15,
    title: "docs: add fish shell configuration and plugin bootstrap",
    state: "OPEN",
    isDraft: false,
    url: "https://github.com/jdoe/dotfiles/pull/15",
    createdAt: "2026-03-30T16:45:00Z",
    updatedAt: "2026-04-02T20:10:00Z",
    author: { login: "rlee", avatarUrl: "https://avatars.githubusercontent.com/u/99001?v=4" },
    repository: { nameWithOwner: "jdoe/dotfiles", stargazerCount: 47 },
    headRefName: "docs/fish-shell-guide",
    baseRefName: "main",
    reviewDecision: "APPROVED",
    labels: { nodes: [{ name: "documentation", color: "0075ca" }] },
  },
  {
    id: "PR_kgDOBOpenStack005",
    databaseId: 100005,
    number: 4821,
    title: "perf: parallelize volume attachment in compute scheduler",
    state: "OPEN",
    isDraft: false,
    url: "https://github.com/openstack/nova/pull/4821",
    createdAt: "2026-03-25T07:30:00Z",
    updatedAt: "2026-04-03T11:15:00Z",
    author: { login: "jdoe", avatarUrl: "https://avatars.githubusercontent.com/u/12345?v=4" },
    repository: { nameWithOwner: "openstack/nova", stargazerCount: 5102 },
    headRefName: "perf/parallel-volume-attach",
    baseRefName: "master",
    reviewDecision: "REVIEW_REQUIRED",
    labels: { nodes: [{ name: "performance", color: "fef2c0" }, { name: "compute", color: "c5def5" }] },
  },
  {
    id: "PR_kgDOBcAcmeCorp006",
    databaseId: 100006,
    number: 248,
    title: "refactor: extract shared rate-limiting middleware",
    state: "OPEN",
    isDraft: false,
    url: "https://github.com/acme-corp/web-platform/pull/248",
    createdAt: "2026-04-03T08:00:00Z",
    updatedAt: "2026-04-03T12:00:00Z",
    author: { login: "jdoe", avatarUrl: "https://avatars.githubusercontent.com/u/12345?v=4" },
    repository: { nameWithOwner: "acme-corp/web-platform", stargazerCount: 1842 },
    headRefName: "refactor/rate-limit-middleware",
    baseRefName: "main",
    reviewDecision: null,
    labels: { nodes: [{ name: "refactor", color: "e4e669" }] },
  },
];

const heavyPRNodes = [
  {
    databaseId: 100001,
    headRefOid: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    headRepository: { owner: { login: "jdoe" }, nameWithOwner: "jdoe/web-platform-fork" },
    mergeStateStatus: "CLEAN",
    assignees: { nodes: [] },
    reviewRequests: { nodes: [] },
    latestReviews: {
      totalCount: 2,
      nodes: [{ author: { login: "msmith" } }, { author: { login: "rlee" } }],
    },
    additions: 312,
    deletions: 47,
    changedFiles: 8,
    comments: { totalCount: 6 },
    reviewThreads: { totalCount: 1 },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  },
  {
    databaseId: 100002,
    headRefOid: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
    headRepository: { owner: { login: "msmith" }, nameWithOwner: "acme-corp/api-gateway" },
    mergeStateStatus: "BLOCKED",
    assignees: { nodes: [{ login: "jdoe" }] },
    reviewRequests: { nodes: [] },
    latestReviews: {
      totalCount: 1,
      nodes: [{ author: { login: "jdoe" } }],
    },
    additions: 89,
    deletions: 23,
    changedFiles: 4,
    comments: { totalCount: 12 },
    reviewThreads: { totalCount: 3 },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  },
  {
    databaseId: 100003,
    headRefOid: "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    headRepository: { owner: { login: "jdoe" }, nameWithOwner: "acme-corp/design-system" },
    mergeStateStatus: "DRAFT",
    assignees: { nodes: [] },
    reviewRequests: { nodes: [{ requestedReviewer: { login: "msmith" } }] },
    latestReviews: { totalCount: 0, nodes: [] },
    additions: 1240,
    deletions: 890,
    changedFiles: 31,
    comments: { totalCount: 2 },
    reviewThreads: { totalCount: 0 },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
  },
  {
    databaseId: 100004,
    headRefOid: "d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5",
    headRepository: { owner: { login: "rlee" }, nameWithOwner: "jdoe/dotfiles" },
    mergeStateStatus: "CLEAN",
    assignees: { nodes: [] },
    reviewRequests: { nodes: [] },
    latestReviews: {
      totalCount: 1,
      nodes: [{ author: { login: "jdoe" } }],
    },
    additions: 45,
    deletions: 8,
    changedFiles: 3,
    comments: { totalCount: 1 },
    reviewThreads: { totalCount: 0 },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  },
  {
    databaseId: 100005,
    headRefOid: "e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6",
    headRepository: { owner: { login: "jdoe" }, nameWithOwner: "openstack/nova" },
    mergeStateStatus: "BLOCKED",
    assignees: { nodes: [] },
    reviewRequests: { nodes: [{ requestedReviewer: { login: "msmith" } }, { requestedReviewer: { login: "rlee" } }] },
    latestReviews: { totalCount: 0, nodes: [] },
    additions: 678,
    deletions: 142,
    changedFiles: 14,
    comments: { totalCount: 8 },
    reviewThreads: { totalCount: 2 },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
  },
  {
    databaseId: 100006,
    headRefOid: "f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1",
    headRepository: { owner: { login: "jdoe" }, nameWithOwner: "acme-corp/web-platform" },
    mergeStateStatus: "UNKNOWN",
    assignees: { nodes: [] },
    reviewRequests: { nodes: [{ requestedReviewer: { login: "msmith" } }] },
    latestReviews: { totalCount: 0, nodes: [] },
    additions: 156,
    deletions: 34,
    changedFiles: 6,
    comments: { totalCount: 0 },
    reviewThreads: { totalCount: 0 },
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
  },
];

const lightIssueNodes = [
  {
    databaseId: 200001,
    number: 1023,
    title: "OAuth login fails on Safari when third-party cookies are blocked",
    state: "OPEN",
    url: "https://github.com/acme-corp/web-platform/issues/1023",
    createdAt: "2026-03-29T10:00:00Z",
    updatedAt: "2026-04-02T15:30:00Z",
    author: { login: "bwilson", avatarUrl: "https://avatars.githubusercontent.com/u/44444?v=4" },
    assignees: { nodes: [{ login: "jdoe" }] },
    labels: { nodes: [{ name: "bug", color: "d73a4a" }, { name: "auth", color: "e4e669" }] },
    comments: { totalCount: 14 },
    repository: { nameWithOwner: "acme-corp/web-platform", stargazerCount: 1842 },
  },
  {
    databaseId: 200002,
    number: 445,
    title: "Add request tracing headers for distributed debugging",
    state: "OPEN",
    url: "https://github.com/acme-corp/api-gateway/issues/445",
    createdAt: "2026-04-01T09:20:00Z",
    updatedAt: "2026-04-03T11:00:00Z",
    author: { login: "jdoe", avatarUrl: "https://avatars.githubusercontent.com/u/12345?v=4" },
    assignees: { nodes: [] },
    labels: { nodes: [{ name: "enhancement", color: "a2eeef" }, { name: "observability", color: "c5def5" }] },
    comments: { totalCount: 3 },
    repository: { nameWithOwner: "acme-corp/api-gateway", stargazerCount: 573 },
  },
  {
    databaseId: 200003,
    number: 62,
    title: "Button component missing aria-disabled when loading state active",
    state: "OPEN",
    url: "https://github.com/acme-corp/design-system/issues/62",
    createdAt: "2026-03-31T13:45:00Z",
    updatedAt: "2026-04-01T09:00:00Z",
    author: { login: "jdoe", avatarUrl: "https://avatars.githubusercontent.com/u/12345?v=4" },
    assignees: { nodes: [{ login: "jdoe" }] },
    labels: { nodes: [{ name: "accessibility", color: "7057ff" }, { name: "bug", color: "d73a4a" }] },
    comments: { totalCount: 7 },
    repository: { nameWithOwner: "acme-corp/design-system", stargazerCount: 228 },
  },
  {
    databaseId: 200004,
    number: 7834,
    title: "Live migration fails when instance has SR-IOV NIC attached",
    state: "OPEN",
    url: "https://github.com/openstack/nova/issues/7834",
    createdAt: "2026-03-20T08:00:00Z",
    updatedAt: "2026-04-03T10:00:00Z",
    author: { login: "kpatel", avatarUrl: "https://avatars.githubusercontent.com/u/55555?v=4" },
    assignees: { nodes: [{ login: "jdoe" }, { login: "msmith" }] },
    labels: { nodes: [{ name: "bug", color: "d73a4a" }, { name: "compute", color: "c5def5" }, { name: "high-priority", color: "e11d48" }] },
    comments: { totalCount: 31 },
    repository: { nameWithOwner: "openstack/nova", stargazerCount: 5102 },
  },
];

const workflowRunsResponse = {
  total_count: 8,
  workflow_runs: [
    {
      id: 9001,
      name: "CI",
      status: "completed",
      conclusion: "success",
      event: "push",
      workflow_id: 801,
      head_sha: "a1b2c3d4",
      head_branch: "main",
      run_number: 412,
      html_url: "https://github.com/acme-corp/web-platform/actions/runs/9001",
      created_at: "2026-04-03T09:00:00Z",
      updated_at: "2026-04-03T09:12:00Z",
      run_started_at: "2026-04-03T09:00:30Z",
      completed_at: "2026-04-03T09:12:00Z",
      run_attempt: 1,
      display_title: "feat: passkey auth",
      actor: { login: "jdoe" },
    },
    {
      id: 9002,
      name: "Deploy Preview",
      status: "completed",
      conclusion: "failure",
      event: "pull_request",
      workflow_id: 802,
      head_sha: "b2c3d4e5",
      head_branch: "fix/n-plus-one-profile",
      run_number: 87,
      html_url: "https://github.com/acme-corp/api-gateway/actions/runs/9002",
      created_at: "2026-04-03T08:30:00Z",
      updated_at: "2026-04-03T08:41:00Z",
      run_started_at: "2026-04-03T08:30:15Z",
      completed_at: "2026-04-03T08:41:00Z",
      run_attempt: 1,
      display_title: "fix: resolve N+1 query",
      actor: { login: "msmith" },
    },
    {
      id: 9003,
      name: "CI",
      status: "in_progress",
      conclusion: null,
      event: "pull_request",
      workflow_id: 803,
      head_sha: "c3d4e5f6",
      head_branch: "chore/design-token-rename",
      run_number: 34,
      html_url: "https://github.com/acme-corp/design-system/actions/runs/9003",
      created_at: "2026-04-03T11:55:00Z",
      updated_at: "2026-04-03T12:01:00Z",
      run_started_at: "2026-04-03T11:55:30Z",
      completed_at: null,
      run_attempt: 1,
      display_title: "chore: design token rename",
      actor: { login: "jdoe" },
    },
  ],
};

// ── Test ──────────────────────────────────────────────────────────────────────

test("capture dashboard screenshot", async ({ page }) => {
  // 1a. Seed localStorage before any navigation
  await page.addInitScript(() => {
    // Clear any stale view state (e.g. notification drawer open from a previous run)
    localStorage.removeItem("github-tracker:view");
    localStorage.setItem("github-tracker:auth-token", "fake-screenshot-token");
    localStorage.setItem(
      "github-tracker:config",
      JSON.stringify({
        onboardingComplete: true,
        selectedOrgs: ["acme-corp", "jdoe", "openstack"],
        selectedRepos: [
          { owner: "acme-corp", name: "web-platform", fullName: "acme-corp/web-platform" },
          { owner: "acme-corp", name: "api-gateway", fullName: "acme-corp/api-gateway" },
          { owner: "acme-corp", name: "design-system", fullName: "acme-corp/design-system" },
          { owner: "jdoe", name: "dotfiles", fullName: "jdoe/dotfiles" },
          { owner: "jdoe", name: "blog", fullName: "jdoe/blog" },
          { owner: "openstack", name: "nova", fullName: "openstack/nova" },
        ],
        trackedUsers: [
          {
            login: "jdoe",
            avatarUrl: "https://avatars.githubusercontent.com/u/12345?v=4",
            name: "Jane Doe",
            type: "user",
          },
        ],
        theme: "dark",
      })
    );
  });

  // 1b. Mock all GitHub API routes before navigation.
  // Routes are matched in reverse registration order (last registered = highest priority).
  // Register the catch-all FIRST so specific routes registered after it take priority.
  // The catch-all aborts unmocked requests so they fail loudly instead of silently succeeding.
  await page.route("https://api.github.com/**", (route) => route.abort());

  await page.route("https://api.github.com/notifications*", (route) =>
    route.fulfill({ status: 200, json: [] })
  );

  await page.route("https://api.github.com/repos/*/*/actions/runs*", (route) =>
    route.fulfill({
      status: 200,
      json: workflowRunsResponse,
    })
  );

  await page.route("https://api.github.com/graphql", async (route) => {
    const body = route.request().postDataJSON() as { query?: string; variables?: Record<string, unknown> } | null;
    const query = body?.query ?? "";
    const variables = body?.variables ?? {};

    // Heavy backfill: nodes(ids: [...]) — detected by query string content
    if (query.includes("nodes(ids:")) {
      return route.fulfill({
        status: 200,
        json: {
          data: {
            nodes: heavyPRNodes,
            rateLimit: { limit: 5000, remaining: 4900, resetAt: RESET_AT },
          },
        },
      });
    }

    // Light combined search: LIGHT_COMBINED_SEARCH_QUERY uses issueQ/prInvQ/prRevQ variables
    if ("issueQ" in variables || "prInvQ" in variables || "prRevQ" in variables) {
      return route.fulfill({
        status: 200,
        json: {
          data: {
            issues: {
              issueCount: lightIssueNodes.length,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: lightIssueNodes,
            },
            prInvolves: {
              issueCount: lightPRNodes.length,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: lightPRNodes,
            },
            prReviewReq: {
              issueCount: 0,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
            rateLimit: { limit: 5000, remaining: 4950, resetAt: RESET_AT },
          },
        },
      });
    }

    // Fallback: minimal rate limit response
    return route.fulfill({
      status: 200,
      json: {
        data: {
          rateLimit: { limit: 5000, remaining: 4900, resetAt: RESET_AT },
        },
      },
    });
  });

  // /user registered last so it has the highest priority (matched before the catch-all)
  await page.route("https://api.github.com/user", (route) =>
    route.fulfill({
      status: 200,
      json: {
        login: "jdoe",
        name: "Jane Doe",
        avatar_url: "https://avatars.githubusercontent.com/u/12345?v=4",
        id: 12345,
      },
    })
  );

  // 1c. Navigate and capture
  await page.goto("/dashboard");
  await page.getByRole("tablist").waitFor();
  await page.waitForLoadState("networkidle");

  // Switch to Pull Requests tab for a richer screenshot
  await page.getByRole("tab", { name: /pull requests/i }).click();
  await page.getByRole("tab", { name: /pull requests/i, selected: true }).waitFor();

  // Wait for repo group headers to render (visible even when collapsed)
  await page.getByText("acme-corp/web-platform").first().waitFor();

  // Expand a repo group by clicking its header button (scoped to avoid notification bell)
  const repoGroupBtn = page.getByRole("button", { expanded: false }).filter({ hasText: "acme-corp/web-platform" });
  if (await repoGroupBtn.isVisible()) {
    await repoGroupBtn.click();
    await page.getByRole("button", { expanded: true }).filter({ hasText: "acme-corp/web-platform" }).waitFor();
  }

  await page.screenshot({ path: "docs/dashboard-screenshot.png" });
});

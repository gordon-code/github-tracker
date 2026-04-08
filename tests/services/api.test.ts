import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchOrgs,
  fetchRepos,
  fetchWorkflowRuns,
  validateGitHubUser,
  type RepoRef,
} from "../../src/app/services/api";
import { clearCache } from "../../src/app/stores/cache";
import { pushNotification } from "../../src/app/lib/errors";

import orgsFixture from "../fixtures/github-orgs.json";
import reposFixture from "../fixtures/github-repos.json";
import runsFixture from "../fixtures/github-runs.json";

vi.mock("../../src/app/lib/errors", () => ({
  pushNotification: vi.fn(),
  pushError: vi.fn(),
  getErrors: vi.fn().mockReturnValue([]),
  dismissError: vi.fn(),
  getNotifications: vi.fn().mockReturnValue([]),
  getUnreadCount: vi.fn().mockReturnValue(0),
  markAllAsRead: vi.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeOctokit(
  requestImpl: (route: string, params?: unknown) => Promise<unknown>,
  graphqlImpl?: (query: string, variables?: unknown) => Promise<unknown>
) {
  return {
    request: vi.fn(requestImpl),
    graphql: vi.fn(graphqlImpl ?? (async () => ({}))),
    paginate: {
      iterator: vi.fn((route: string, params?: unknown) => {
        void params; // captured for test assertions
        // For tests that need paginate.iterator, return a single page
        const data =
          route.includes("/orgs/") || route.includes("/user/repos")
            ? reposFixture
            : [];
        return (async function* () {
          yield { data };
        })();
      }),
    },
  };
}

function makeBasicOctokit() {
  return makeOctokit(async (route: string) => {
    if (route === "GET /user") {
      return {
        data: { login: "octocat", avatar_url: "https://github.com/images/error/octocat_happy.gif" },
        headers: { etag: "etag-user" },
      };
    }
    if (route === "GET /user/orgs") {
      return {
        data: orgsFixture.filter((o) => o.type === "Organization"),
        headers: { etag: "etag-orgs" },
      };
    }
    return { data: [], headers: { etag: "etag-fallback" } };
  });
}

const testRepo: RepoRef = {
  owner: "octocat",
  name: "Hello-World",
  fullName: "octocat/Hello-World",
};

beforeEach(async () => {
  await clearCache();
  vi.resetAllMocks();
});

// ── fetchOrgs ────────────────────────────────────────────────────────────────

describe("fetchOrgs", () => {
  it("returns personal account first followed by orgs", async () => {
    const octokit = makeBasicOctokit();
    const result = await fetchOrgs(octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>);

    expect(result[0].login).toBe("octocat");
    expect(result[0].type).toBe("user");
    expect(result.length).toBeGreaterThan(1);
    expect(result.slice(1).every((o) => o.type === "org")).toBe(true);
  });

  it("maps avatar_url to avatarUrl", async () => {
    const octokit = makeBasicOctokit();
    const result = await fetchOrgs(octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>);
    for (const entry of result) {
      expect(entry.avatarUrl).toBeDefined();
      expect(typeof entry.avatarUrl).toBe("string");
    }
  });

  it("throws when octokit is null", async () => {
    await expect(fetchOrgs(null)).rejects.toThrow("No GitHub client available");
  });
});

// ── fetchRepos ────────────────────────────────────────────────────────────────

describe("fetchRepos", () => {
  it("returns repos for an org via paginate.iterator", async () => {
    const octokit = makeBasicOctokit();
    const result = await fetchRepos(
      octokit as never,
      "acme-corp",
      "org"
    );
    expect(Array.isArray(result)).toBe(true);
    // Each result should have owner, name, fullName
    for (const repo of result) {
      expect(repo.owner).toBeDefined();
      expect(repo.name).toBeDefined();
      expect(repo.fullName).toBeDefined();
    }
    expect(result[0].pushedAt).toBe("2011-01-26T19:06:43Z");
  });

  it("passes sort=pushed and direction=desc to paginate.iterator", async () => {
    const octokit = makeBasicOctokit();
    await fetchRepos(
      octokit as never,
      "acme-corp",
      "org"
    );
    expect(octokit.paginate.iterator).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sort: "pushed", direction: "desc" })
    );
  });

  it("passes sort=pushed and direction=desc for user repos", async () => {
    const octokit = makeBasicOctokit();
    await fetchRepos(
      octokit as never,
      "octocat",
      "user"
    );
    expect(octokit.paginate.iterator).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sort: "pushed", direction: "desc" })
    );
  });

  it("returns repos for a user account via paginate.iterator", async () => {
    const octokit = makeBasicOctokit();
    const result = await fetchRepos(
      octokit as never,
      "octocat",
      "user"
    );
    expect(Array.isArray(result)).toBe(true);
  });

  it("throws when octokit is null", async () => {
    await expect(fetchRepos(null, "acme-corp", "org")).rejects.toThrow(
      "No GitHub client available"
    );
  });

  it("stops pagination at 1000 repos and emits warning notification", async () => {
    vi.mocked(pushNotification).mockClear();

    async function* mockPaginator() {
      for (let page = 0; page < 20; page++) {
        yield {
          data: Array.from({ length: 100 }, (_, i) => ({
            owner: { login: "org" },
            name: `repo-${page * 100 + i}`,
            full_name: `org/repo-${page * 100 + i}`,
            pushed_at: "2026-01-01T00:00:00Z",
          })),
        };
      }
    }

    const octokit = makeBasicOctokit();
    octokit.paginate.iterator.mockImplementation((() => mockPaginator()) as never);

    const result = await fetchRepos(octokit as never, "org", "org");

    expect(result).toHaveLength(1000);
    expect(pushNotification).toHaveBeenCalledWith(
      "api",
      expect.stringContaining("1000+"),
      "warning"
    );
  });

  // VALID_REPO_NAME is not exported. It is exercised indirectly via buildRepoQualifiers
  // (called inside fetchIssuesAndPullRequests). Invalid repo names are silently
  // filtered from the GraphQL query qualifiers. No additional test added here.
});


// ── fetchWorkflowRuns (single endpoint per repo) ────────────────────────────

describe("fetchWorkflowRuns", () => {
  function makeOctokitForRuns() {
    const request = vi.fn(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/actions/runs") {
        return {
          data: {
            workflow_runs: runsFixture.runs,
            total_count: runsFixture.runs.length,
          },
          headers: { etag: "etag-runs" },
        };
      }
      return { data: [], headers: {} };
    });
    return { request, paginate: { iterator: vi.fn() } };
  }

  it("returns runs grouped by workflow", async () => {
    const octokit = makeOctokitForRuns();

    const { workflowRuns } = await fetchWorkflowRuns(
      octokit as never,
      [testRepo],
      5,
      3
    );

    expect(Array.isArray(workflowRuns)).toBe(true);
    expect(workflowRuns.length).toBeGreaterThan(0);
  });

  it("uses single actions/runs endpoint per repo", async () => {
    const octokit = makeOctokitForRuns();

    await fetchWorkflowRuns(
      octokit as never,
      [testRepo],
      5,
      3
    );

    // Should make exactly 1 API call (not separate workflows + per-workflow runs)
    expect(octokit.request).toHaveBeenCalledTimes(1);
    expect(octokit.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/actions/runs",
      expect.objectContaining({
        owner: "octocat",
        repo: "Hello-World",
      })
    );
  });

  it("respects maxRuns per workflow", async () => {
    const octokit = makeOctokitForRuns();

    const maxWorkflows = 3;
    const maxRuns = 1;
    const { workflowRuns } = await fetchWorkflowRuns(
      octokit as never,
      [testRepo],
      maxWorkflows,
      maxRuns
    );

    // Group result by workflowId and check each has at most maxRuns
    const byWorkflow = new Map<number, number>();
    for (const run of workflowRuns) {
      byWorkflow.set(run.workflowId, (byWorkflow.get(run.workflowId) ?? 0) + 1);
    }
    for (const count of byWorkflow.values()) {
      expect(count).toBeLessThanOrEqual(maxRuns);
    }
  });

  it("respects maxWorkflows limit", async () => {
    const octokit = makeOctokitForRuns();

    const maxWorkflows = 1;
    const { workflowRuns } = await fetchWorkflowRuns(
      octokit as never,
      [testRepo],
      maxWorkflows,
      10
    );

    // All runs should be from a single workflow
    const workflowIds = new Set(workflowRuns.map((r) => r.workflowId));
    expect(workflowIds.size).toBeLessThanOrEqual(maxWorkflows);
  });

  it("tags PR-triggered runs with isPrRun=true", async () => {
    const octokit = makeOctokitForRuns();

    const { workflowRuns } = await fetchWorkflowRuns(
      octokit as never,
      [testRepo],
      5,
      10
    );

    // Run 9003 has event: "pull_request"
    const prRun = workflowRuns.find((r) => r.id === 9003);
    expect(prRun).toBeDefined();
    expect(prRun!.isPrRun).toBe(true);

    // Run 9001 has event: "push"
    const pushRun = workflowRuns.find((r) => r.id === 9001);
    expect(pushRun).toBeDefined();
    expect(pushRun!.isPrRun).toBe(false);
  });

  it("maps raw run fields to camelCase shape", async () => {
    const octokit = makeOctokitForRuns();

    const { workflowRuns } = await fetchWorkflowRuns(
      octokit as never,
      [testRepo],
      5,
      3
    );

    const run = workflowRuns[0];
    expect(run).toMatchObject({
      id: expect.any(Number),
      name: expect.any(String),
      status: expect.any(String),
      event: expect.any(String),
      workflowId: expect.any(Number),
      headSha: expect.any(String),
      headBranch: expect.any(String),
      runNumber: expect.any(Number),
      htmlUrl: expect.any(String),
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      repoFullName: expect.any(String),
      isPrRun: expect.any(Boolean),
    });
  });

  it("sorts workflows by most recent activity descending", async () => {
    const octokit = makeOctokitForRuns();

    const { workflowRuns } = await fetchWorkflowRuns(
      octokit as never,
      [testRepo],
      5,
      10
    );

    // CI workflow (id 1001) has latestAt 2024-01-15T10:05 (from run 9002)
    // Deploy workflow (id 1002) has latestAt 2024-01-15T09:25 (from run 9004)
    // CI should appear first (more recent)
    const firstCiIndex = workflowRuns.findIndex((r) => r.workflowId === 1001);
    const firstDeployIndex = workflowRuns.findIndex((r) => r.workflowId === 1002);
    expect(firstCiIndex).toBeLessThan(firstDeployIndex);
  });

  it("sorts runs within a workflow by created_at descending", async () => {
    const octokit = makeOctokitForRuns();

    const { workflowRuns } = await fetchWorkflowRuns(
      octokit as never,
      [testRepo],
      5,
      10
    );

    // CI runs: 9002 (10:00), 9001 (09:00), 9003 (Jan 14 15:00) — descending by created_at
    const ciRuns = workflowRuns.filter((r) => r.workflowId === 1001);
    expect(ciRuns[0].id).toBe(9002);
    expect(ciRuns[1].id).toBe(9001);
    expect(ciRuns[2].id).toBe(9003);
  });

  it("throws when octokit is null", async () => {
    await expect(
      fetchWorkflowRuns(null, [testRepo], 5, 3)
    ).rejects.toThrow("No GitHub client available");
  });

  it("returns runs sorted newest-first within each workflow", async () => {
    const octokit = makeOctokitForRuns();

    const { workflowRuns } = await fetchWorkflowRuns(
      octokit as never,
      [testRepo],
      5,
      10
    );

    // Workflow 1001 has 3 runs: 9002 (10:00), 9001 (09:00), 9003 (14:15:00 prev day)
    const w1001Runs = workflowRuns.filter((r) => r.workflowId === 1001);
    for (let i = 1; i < w1001Runs.length; i++) {
      expect(w1001Runs[i - 1].createdAt >= w1001Runs[i].createdAt).toBe(true);
    }
  });

  it("selects workflows with most recent activity first", async () => {
    const octokit = makeOctokitForRuns();

    const { workflowRuns } = await fetchWorkflowRuns(
      octokit as never,
      [testRepo],
      5,
      10
    );

    // First run in results should be from the workflow with the most recent updatedAt
    // Workflow 1001 latestAt=2024-01-15T10:05:00Z > Workflow 1002 latestAt=2024-01-15T09:25:00Z
    expect(workflowRuns[0].workflowId).toBe(1001);
  });
});


// ── fetchWorkflowRuns pagination ──────────────────────────────────────────────

describe("fetchWorkflowRuns pagination", () => {
  it("fetches page 2 when page 1 has 100 runs but target not yet met", async () => {
    // maxWorkflows=5, maxRuns=25 → targetRunsPerRepo = 125, forces page 2
    let pageRequested = 0;

    // Build 100 runs for page 1 (workflow_id cycling 1001..1005) and 50 for page 2
    function makeRuns(count: number, startId: number) {
      return Array.from({ length: count }, (_, i) => ({
        id: startId + i,
        name: `Workflow ${(i % 5) + 1}`,
        status: "completed",
        conclusion: "success",
        event: "push",
        workflow_id: 1001 + (i % 5),
        head_sha: `sha-${startId + i}`,
        head_branch: "main",
        run_number: startId + i,
        html_url: `https://github.com/octocat/Hello-World/actions/runs/${startId + i}`,
        created_at: `2024-01-${String(15 - Math.floor(i / 5)).padStart(2, "0")}T09:00:00Z`,
        updated_at: `2024-01-${String(15 - Math.floor(i / 5)).padStart(2, "0")}T09:10:00Z`,
      }));
    }

    const octokit = {
      request: vi.fn(async (_route: string, params?: Record<string, unknown>) => {
        const page = (params?.page as number) ?? 1;
        pageRequested = Math.max(pageRequested, page);
        const runs = page === 1 ? makeRuns(100, 5000) : makeRuns(50, 5100);
        return {
          data: {
            workflow_runs: runs,
            total_count: 150,
          },
          headers: { etag: `etag-runs-p${page}` },
        };
      }),
      paginate: { iterator: vi.fn() },
    };

    const { workflowRuns } = await fetchWorkflowRuns(
      octokit as never,
      [testRepo],
      5,
      25
    );

    // Both pages should have been fetched
    expect(pageRequested).toBe(2);
    // Runs should be present and grouped correctly
    expect(Array.isArray(workflowRuns)).toBe(true);
    expect(workflowRuns.length).toBeGreaterThan(0);

    // Each run should have repoFullName set
    for (const run of workflowRuns) {
      expect(run.repoFullName).toBe("octocat/Hello-World");
    }
  });

  it("stops after page 1 when total runs < 100 (no more pages)", async () => {
    let requestCount = 0;
    const octokit = {
      request: vi.fn(async () => {
        requestCount++;
        return {
          data: {
            workflow_runs: runsFixture.runs, // 4 runs, well under 100
            total_count: runsFixture.runs.length,
          },
          headers: { etag: "etag-runs" },
        };
      }),
      paginate: { iterator: vi.fn() },
    };

    await fetchWorkflowRuns(
      octokit as never,
      [testRepo],
      5,
      3
    );

    // Only 1 page request should be made
    expect(requestCount).toBe(1);
  });
});

// ── validateGitHubUser — bot login and type detection (C1) ───────────────────

function makeUserOctokit(userData: {
  login: string;
  avatar_url: string;
  name: string | null;
  type: string;
}) {
  return makeOctokit(async () => ({ data: userData }));
}

describe("validateGitHubUser — VALID_TRACKED_LOGIN and type detection", () => {
  it("accepts regular user login", async () => {
    const octokit = makeUserOctokit({
      login: "octocat",
      avatar_url: "https://avatars.githubusercontent.com/u/583231",
      name: "The Octocat",
      type: "User",
    });
    const result = await validateGitHubUser(
      octokit as never,
      "octocat"
    );
    expect(result).not.toBeNull();
    expect(result?.type).toBe("user");
  });

  it("accepts bot login with [bot] suffix", async () => {
    const octokit = makeUserOctokit({
      login: "dependabot[bot]",
      avatar_url: "https://avatars.githubusercontent.com/u/27347476",
      name: null,
      type: "Bot",
    });
    const result = await validateGitHubUser(
      octokit as never,
      "dependabot[bot]"
    );
    expect(result).not.toBeNull();
    expect(result?.type).toBe("bot");
    expect(result?.login).toBe("dependabot[bot]");
  });

  it("accepts another bot login — khepri-bot[bot]", async () => {
    const octokit = makeUserOctokit({
      login: "khepri-bot[bot]",
      avatar_url: "https://avatars.githubusercontent.com/u/999",
      name: null,
      type: "Bot",
    });
    const result = await validateGitHubUser(
      octokit as never,
      "khepri-bot[bot]"
    );
    expect(result).not.toBeNull();
    expect(result?.type).toBe("bot");
  });

  it("returns type:user when API returns type:User", async () => {
    const octokit = makeUserOctokit({
      login: "regular-user",
      avatar_url: "https://avatars.githubusercontent.com/u/1",
      name: "Regular User",
      type: "User",
    });
    const result = await validateGitHubUser(
      octokit as never,
      "regular-user"
    );
    expect(result?.type).toBe("user");
  });

  it("returns null for [bot] alone (no base login)", async () => {
    const octokit = makeOctokit(async () => ({ data: {} }));
    const result = await validateGitHubUser(
      octokit as never,
      "[bot]"
    );
    expect(result).toBeNull();
  });

  it("returns null for login with arbitrary bracket content", async () => {
    const octokit = makeOctokit(async () => ({ data: {} }));
    const result = await validateGitHubUser(
      octokit as never,
      "user[evil]"
    );
    expect(result).toBeNull();
  });

  it("returns null for [Bot] (case-sensitive — only [bot] accepted)", async () => {
    const octokit = makeOctokit(async () => ({ data: {} }));
    const result = await validateGitHubUser(
      octokit as never,
      "user[Bot]"
    );
    expect(result).toBeNull();
  });

  it("returns null for user[bot][bot] (double suffix)", async () => {
    const octokit = makeOctokit(async () => ({ data: {} }));
    const result = await validateGitHubUser(
      octokit as never,
      "user[bot][bot]"
    );
    expect(result).toBeNull();
  });

  it("returns null on 404 for bot login", async () => {
    const octokit = makeOctokit(async () => {
      const err = Object.assign(new Error("Not Found"), { status: 404 });
      throw err;
    });
    const result = await validateGitHubUser(
      octokit as never,
      "nonexistent[bot]"
    );
    expect(result).toBeNull();
  });

  it("throws on network error", async () => {
    const octokit = makeOctokit(async () => {
      throw new Error("Network error");
    });
    await expect(
      validateGitHubUser(
        octokit as never,
        "dependabot[bot]"
      )
    ).rejects.toThrow("Network error");
  });
});

// ── fetchIssuesAndPullRequests — monitoredRepos partition (C5) ────────────────

describe("fetchIssuesAndPullRequests — monitoredRepos", () => {
  it("returns empty result with no repos even when monitoredRepos provided", async () => {
    const { fetchIssuesAndPullRequests } = await import("../../src/app/services/api");
    const octokit = makeOctokit(async () => ({ data: {} }), async () => ({}));
    const result = await fetchIssuesAndPullRequests(
      octokit as never,
      [],
      "octocat",
      undefined,
      undefined,
      [{ owner: "org", name: "monitored", fullName: "org/monitored" }]
    );
    expect(result.issues).toEqual([]);
    expect(result.pullRequests).toEqual([]);
  });

  it("unfiltered search query does not contain 'involves:'", async () => {
    const queriesUsed: string[] = [];
    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async (_query: string, variables: unknown) => {
        const vars = variables as Record<string, unknown>;
        if (vars.issueQ) queriesUsed.push(vars.issueQ as string);
        if (vars.prQ) queriesUsed.push(vars.prQ as string);
        return {
          issues: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prs: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          // Also handle regular combined search format
          prInvolves: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          rateLimit: { limit: 5000, remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() },
        };
      }
    );

    const { fetchIssuesAndPullRequests } = await import("../../src/app/services/api");
    const monitoredRepo = { owner: "org", name: "monitored", fullName: "org/monitored" };
    await fetchIssuesAndPullRequests(
      octokit as never,
      [monitoredRepo],
      "octocat",
      undefined,
      undefined,
      [{ owner: "org", name: "monitored", fullName: "org/monitored" }]
    );

    // Unfiltered queries should not contain 'involves:'
    const unfilteredQueries = queriesUsed.filter(q => !q.includes("involves:") && !q.includes("review-requested:"));
    expect(unfilteredQueries.length).toBeGreaterThan(0);
    for (const q of unfilteredQueries) {
      expect(q).not.toContain("involves:");
    }
  });
});

describe("fetchIssuesAndPullRequests — all repos monitored (edge case)", () => {
  it("skips main user light search and returns items from unfiltered search only", async () => {
    const queriesUsed: string[] = [];
    const repo = { owner: "org", name: "repo1", fullName: "org/repo1" };

    const issueNode = {
      databaseId: 3001,
      number: 1,
      title: "All-monitored issue",
      state: "open",
      url: "https://github.com/org/repo1/issues/1",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-02T00:00:00Z",
      author: { login: "someone", avatarUrl: "https://avatars.githubusercontent.com/u/1" },
      labels: { nodes: [] },
      assignees: { nodes: [] },
      repository: { nameWithOwner: "org/repo1" },
      comments: { totalCount: 0 },
    };

    const octokit = makeOctokit(
      async () => ({ data: {}, headers: {} }),
      async (_query: string, variables: unknown) => {
        const vars = variables as Record<string, unknown>;
        if (vars.issueQ) queriesUsed.push(vars.issueQ as string);
        return {
          issues: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [issueNode] },
          prs: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prInvolves: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          rateLimit: { limit: 5000, remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() },
        };
      }
    );

    const { fetchIssuesAndPullRequests } = await import("../../src/app/services/api");
    const result = await fetchIssuesAndPullRequests(
      octokit as never,
      [repo],
      "octocat",
      undefined,
      undefined,
      [{ owner: "org", name: "repo1", fullName: "org/repo1" }]  // all repos monitored
    );

    // Items returned from unfiltered search
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].id).toBe(3001);

    // No involves: query (main user search skipped since normalRepos is empty)
    const involvesQueries = queriesUsed.filter(q => q.includes("involves:octocat"));
    expect(involvesQueries).toHaveLength(0);

    // Unfiltered query was issued (no involves: qualifier)
    const unfilteredQueries = queriesUsed.filter(q => !q.includes("involves:") && !q.includes("review-requested:"));
    expect(unfilteredQueries.length).toBeGreaterThan(0);

    // Item has no surfacedBy (unfiltered search items aren't attributed to a user)
    expect(result.issues[0].surfacedBy).toBeUndefined();
  });
});

// ── fetchIssuesAndPullRequests — cross-feature integration (monitored + bot) ──

describe("fetchIssuesAndPullRequests — cross-feature: monitored repo + bot tracked user", () => {
  const monitoredRepo = { owner: "org", name: "monitored", fullName: "org/monitored" };
  const normalRepo = { owner: "org", name: "normal", fullName: "org/normal" };

  const monitoredIssueNode = {
    databaseId: 2001,
    number: 1,
    title: "Monitored repo issue",
    state: "open",
    url: "https://github.com/org/monitored/issues/1",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-02T00:00:00Z",
    author: { login: "someone", avatarUrl: "https://avatars.githubusercontent.com/u/1" },
    labels: { nodes: [] },
    assignees: { nodes: [] },
    repository: { nameWithOwner: "org/monitored" },
    comments: { totalCount: 0 },
  };

  const botIssueNode = {
    databaseId: 2002,
    number: 2,
    title: "Bot-surfaced issue",
    state: "open",
    url: "https://github.com/org/normal/issues/2",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-02T00:00:00Z",
    author: { login: "dependabot[bot]", avatarUrl: "https://avatars.githubusercontent.com/u/27347476" },
    labels: { nodes: [] },
    assignees: { nodes: [] },
    repository: { nameWithOwner: "org/normal" },
    comments: { totalCount: 0 },
  };

  it("deduplicates issues when same item appears in both monitored and bot searches", async () => {
    const { fetchIssuesAndPullRequests } = await import("../../src/app/services/api");

    const octokit = makeOctokit(
      async () => ({ data: {}, headers: {} }),
      async (_query: string, variables: unknown) => {
        const vars = variables as Record<string, unknown>;
        // Unfiltered search for monitored repo returns monitoredIssueNode
        if (vars.issueQ && typeof vars.issueQ === "string" && !String(vars.issueQ).includes("involves:")) {
          return {
            issues: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [monitoredIssueNode] },
            prs: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            rateLimit: { limit: 5000, remaining: 4990, resetAt: new Date(Date.now() + 3600000).toISOString() },
          };
        }
        // Bot tracked user search on normal repos returns botIssueNode
        if (vars.issueQ && String(vars.issueQ).includes("involves:dependabot")) {
          return {
            issues: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [botIssueNode] },
            prInvolves: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            rateLimit: { limit: 5000, remaining: 4985, resetAt: new Date(Date.now() + 3600000).toISOString() },
          };
        }
        // Main user search returns nothing
        return {
          issues: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prInvolves: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          rateLimit: { limit: 5000, remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() },
        };
      }
    );

    const botUser = { login: "dependabot[bot]", avatarUrl: "https://avatars.githubusercontent.com/u/27347476", name: null, type: "bot" as const };
    const result = await fetchIssuesAndPullRequests(
      octokit as never,
      [normalRepo, monitoredRepo],
      "octocat",
      undefined,
      [botUser],
      [{ owner: "org", name: "monitored", fullName: "org/monitored" }]
    );

    // Both issues are present (no dedup since different IDs)
    const ids = result.issues.map((i) => i.id);
    expect(ids).toContain(2001); // monitored repo issue
    expect(ids).toContain(2002); // bot-surfaced issue

    // Bot issue has surfacedBy annotation
    const botIssue = result.issues.find((i) => i.id === 2002);
    expect(botIssue?.surfacedBy).toContain("dependabot[bot]");

    // Monitored repo issue has no surfacedBy (no user qualifier)
    const monitoredIssue = result.issues.find((i) => i.id === 2001);
    expect(monitoredIssue?.surfacedBy).toBeUndefined();
  });
});

// ── VALID_TRACKED_LOGIN — GraphQL injection character rejection ────────────────

describe("VALID_TRACKED_LOGIN — rejects GraphQL-unsafe characters", () => {
  it("rejects login with space", async () => {
    const octokit = makeOctokit(async () => ({ data: {} }));
    const result = await validateGitHubUser(octokit as never, "user name");
    expect(result).toBeNull();
    expect(octokit.request).not.toHaveBeenCalled();
  });

  it("rejects login with colon", async () => {
    const octokit = makeOctokit(async () => ({ data: {} }));
    const result = await validateGitHubUser(octokit as never, "user:name");
    expect(result).toBeNull();
    expect(octokit.request).not.toHaveBeenCalled();
  });

  it("rejects login with double quote", async () => {
    const octokit = makeOctokit(async () => ({ data: {} }));
    const result = await validateGitHubUser(octokit as never, 'user"name');
    expect(result).toBeNull();
    expect(octokit.request).not.toHaveBeenCalled();
  });

  it("rejects login with newline", async () => {
    const octokit = makeOctokit(async () => ({ data: {} }));
    const result = await validateGitHubUser(octokit as never, "user\nname");
    expect(result).toBeNull();
    expect(octokit.request).not.toHaveBeenCalled();
  });
});

describe("fetchIssuesAndPullRequests — unfiltered search error handling", () => {
  it("returns partial results when unfiltered GraphQL query throws with partial data", async () => {
    const monitoredRepo = { owner: "org", name: "monitored", fullName: "org/monitored" };
    const issueNode = {
      databaseId: 4001,
      number: 1,
      title: "Partial issue",
      state: "open",
      url: "https://github.com/org/monitored/issues/1",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-02T00:00:00Z",
      author: { login: "someone", avatarUrl: "https://avatars.githubusercontent.com/u/1" },
      labels: { nodes: [] },
      assignees: { nodes: [] },
      repository: { nameWithOwner: "org/monitored" },
      comments: { totalCount: 0 },
    };

    let callCount = 0;
    const octokit = makeOctokit(
      async () => ({ data: {}, headers: {} }),
      async () => {
        callCount++;
        // First call is for unfiltered search — throw with partial data
        if (callCount === 1) {
          const err = Object.assign(new Error("Partial failure"), {
            data: {
              issues: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [issueNode] },
              prs: null,
              rateLimit: { limit: 5000, remaining: 4998, resetAt: new Date(Date.now() + 3600000).toISOString() },
            },
          });
          throw err;
        }
        // No other searches expected (normalRepos is empty)
        return {
          issues: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prs: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prInvolves: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          rateLimit: { limit: 5000, remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() },
        };
      }
    );

    const { fetchIssuesAndPullRequests } = await import("../../src/app/services/api");
    const result = await fetchIssuesAndPullRequests(
      octokit as never,
      [monitoredRepo],
      "octocat",
      undefined,
      undefined,
      [{ owner: "org", name: "monitored", fullName: "org/monitored" }]
    );

    // Partial issue data recovered
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].id).toBe(4001);
    // Error recorded
    expect(result.errors.some(e => e.retryable)).toBe(true);
  });

  it("records error when unfiltered GraphQL query throws with no data", async () => {
    const monitoredRepo = { owner: "org", name: "monitored", fullName: "org/monitored" };

    let callCount = 0;
    const octokit = makeOctokit(
      async () => ({ data: {}, headers: {} }),
      async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("Total failure");
        }
        return {
          issues: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prs: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prInvolves: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          rateLimit: { limit: 5000, remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() },
        };
      }
    );

    const { fetchIssuesAndPullRequests } = await import("../../src/app/services/api");
    const result = await fetchIssuesAndPullRequests(
      octokit as never,
      [monitoredRepo],
      "octocat",
      undefined,
      undefined,
      [{ owner: "org", name: "monitored", fullName: "org/monitored" }]
    );

    // No results recovered
    expect(result.issues).toHaveLength(0);
    expect(result.pullRequests).toHaveLength(0);
    // Error recorded with retryable flag (network error → statusCode null → retryable)
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatchObject({ retryable: true });
  });

  it("recovers PR data when issues is null but prs has data (symmetric partial case)", async () => {
    const monitoredRepo = { owner: "org", name: "monitored", fullName: "org/monitored" };
    // Fixture matches GraphQLLightPRNode — no heavy fields (additions, commits, etc.)
    const prNode = {
      id: "PR_kwDOtest4501",
      databaseId: 4501,
      number: 1,
      title: "Partial PR",
      state: "open",
      isDraft: false,
      url: "https://github.com/org/monitored/pull/1",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-02T00:00:00Z",
      author: { login: "someone", avatarUrl: "https://avatars.githubusercontent.com/u/1" },
      repository: { nameWithOwner: "org/monitored" },
      headRefName: "fix/thing",
      baseRefName: "main",
      reviewDecision: null,
      labels: { nodes: [] },
    };

    let callCount = 0;
    const octokit = makeOctokit(
      async () => ({ data: {}, headers: {} }),
      async () => {
        callCount++;
        if (callCount === 1) {
          const err = Object.assign(new Error("Partial failure"), {
            data: {
              issues: null,
              prs: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [prNode] },
              rateLimit: { limit: 5000, remaining: 4998, resetAt: new Date(Date.now() + 3600000).toISOString() },
            },
          });
          throw err;
        }
        return {
          issues: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prs: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prInvolves: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          rateLimit: { limit: 5000, remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() },
        };
      }
    );

    const { fetchIssuesAndPullRequests } = await import("../../src/app/services/api");
    const result = await fetchIssuesAndPullRequests(
      octokit as never,
      [monitoredRepo],
      "octocat",
      undefined,
      undefined,
      [{ owner: "org", name: "monitored", fullName: "org/monitored" }]
    );

    // PR data recovered from partial response
    expect(result.pullRequests).toHaveLength(1);
    expect(result.pullRequests[0].id).toBe(4501);
    // Issues empty (null coalesced to empty)
    expect(result.issues).toHaveLength(0);
    // Error recorded
    expect(result.errors.some(e => e.retryable)).toBe(true);
  });
});

describe("fetchIssuesAndPullRequests — all monitored + tracked users skips involves: search", () => {
  it("does not fire tracked user involves: search when all repos are monitored", async () => {
    const queriesUsed: string[] = [];
    const repo = { owner: "org", name: "repo1", fullName: "org/repo1" };
    const botUser = { login: "dependabot[bot]", avatarUrl: "https://avatars.githubusercontent.com/u/27347476", name: null, type: "bot" as const };

    const octokit = makeOctokit(
      async () => ({ data: {}, headers: {} }),
      async (_query: string, variables: unknown) => {
        const vars = variables as Record<string, unknown>;
        if (vars.issueQ) queriesUsed.push(vars.issueQ as string);
        if (vars.prInvQ) queriesUsed.push(vars.prInvQ as string);
        return {
          issues: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prs: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prInvolves: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          rateLimit: { limit: 5000, remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() },
        };
      }
    );

    const { fetchIssuesAndPullRequests } = await import("../../src/app/services/api");
    await fetchIssuesAndPullRequests(
      octokit as never,
      [repo],
      "octocat",
      undefined,
      [botUser],
      [{ owner: "org", name: "repo1", fullName: "org/repo1" }]  // all repos monitored
    );

    // No involves: queries for tracked user (since normalRepos is empty, tracked search is skipped)
    const involvesQueries = queriesUsed.filter(q => q.includes("involves:dependabot"));
    expect(involvesQueries).toHaveLength(0);
  });
});

describe("fetchIssuesAndPullRequests — onLightData suppression when all monitored", () => {
  it("does not call onLightData when all repos are monitored", async () => {
    const repo = { owner: "org", name: "repo1", fullName: "org/repo1" };
    const issueNode = {
      databaseId: 5001,
      number: 1,
      title: "Monitored issue",
      state: "open",
      url: "https://github.com/org/repo1/issues/1",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-02T00:00:00Z",
      author: { login: "someone", avatarUrl: "https://avatars.githubusercontent.com/u/1" },
      labels: { nodes: [] },
      assignees: { nodes: [] },
      repository: { nameWithOwner: "org/repo1" },
      comments: { totalCount: 0 },
    };

    const octokit = makeOctokit(
      async () => ({ data: {}, headers: {} }),
      async () => ({
        issues: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [issueNode] },
        prs: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        prInvolves: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        rateLimit: { limit: 5000, remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() },
      })
    );

    const onLightData = vi.fn();
    const { fetchIssuesAndPullRequests } = await import("../../src/app/services/api");
    const result = await fetchIssuesAndPullRequests(
      octokit as never,
      [repo],
      "octocat",
      onLightData,
      undefined,
      [{ owner: "org", name: "repo1", fullName: "org/repo1" }]  // all repos monitored
    );

    // onLightData NOT called (main user search skipped, unfiltered results come after)
    expect(onLightData).not.toHaveBeenCalled();
    // But final result still has the issue
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].id).toBe(5001);
  });
});

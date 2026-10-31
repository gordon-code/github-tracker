import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Sentry from "@sentry/solid";
import {
  fetchOrgs,
  fetchRepos,
  fetchWorkflowRuns,
  validateGitHubUser,
  fetchPREnrichment,
  fetchHotPRStatus,
  approvePullRequest,
  markPullRequestReady,
  discoverUpstreamRepos,
  fetchIssuesAndPullRequests,
  fallbackToPreviousEnrichment,
  isSameRevision,
  hasRevisionChanged,
  markCheckStatusStale,
  resetPREnrichmentCache,
  invalidatePREnrichmentCacheForRepos,
  evictPREnrichmentCacheNode,
  HEAVY_BACKFILL_BATCH_SIZE,
  MIN_SPLIT_BATCH_SIZE,
  SPLIT_SUPPRESSION_BATCH_THRESHOLD,
  MIN_ENRICHMENT_CACHE_TTL_MS,
  setPREnrichmentCacheRefreshInterval,
  type RepoRef,
} from "../../src/app/services/api";
import { APPROVE_PR_MUTATION, MARK_PR_READY_MUTATION } from "../../src/app/services/github";
import { clearCache } from "../../src/app/stores/cache";
import { pushNotification } from "../../src/app/lib/errors";
import { makePullRequest } from "../helpers/factories";

import orgsFixture from "../fixtures/github-orgs.json";
import reposFixture from "../fixtures/github-repos.json";
import runsFixture from "../fixtures/github-runs.json";

vi.mock("@sentry/solid", () => ({
  captureException: vi.fn(),
}));

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
          route === "GET /user/orgs"
            ? orgsFixture.filter((o) => o.type === "Organization")
            : route.includes("/orgs/") || route.includes("/user/repos")
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
  resetPREnrichmentCache();
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

  it("paginates past a single page of 100 orgs", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      login: `org-${i}`, avatar_url: "https://avatars.githubusercontent.com/u/1", type: "Organization",
    }));
    const page2 = [{ login: "org-101", avatar_url: "https://avatars.githubusercontent.com/u/2", type: "Organization" }];
    const octokit = {
      request: vi.fn(async (route: string) => {
        if (route === "GET /user") {
          return { data: { login: "octocat", avatar_url: "https://github.com/images/error/octocat_happy.gif" }, headers: {} };
        }
        return { data: [], headers: {} };
      }),
      graphql: vi.fn(),
      paginate: {
        iterator: vi.fn(() => (async function* () {
          yield { data: page1 };
          yield { data: page2 };
        })()),
      },
    };
    const result = await fetchOrgs(octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>);

    // Personal account + 101 orgs across two pages — none dropped.
    expect(result.length).toBe(102);
    expect(result.some((o) => o.login === "org-101")).toBe(true);
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

  it("maps isFork boolean from raw fork field", async () => {
    const octokit = makeBasicOctokit();
    const result = await fetchRepos(octokit as never, "octocat", "user");

    const helloWorld = result.find((r) => r.fullName === "octocat/Hello-World");
    const spoonKnife = result.find((r) => r.fullName === "octocat/Spoon-Knife");

    expect(helloWorld?.isFork).toBe(false);
    expect(spoonKnife?.isFork).toBe(true);
  });

  it("excludes archived repositories for both org and user calls", async () => {
    const octokit = makeBasicOctokit();

    const orgResult = await fetchRepos(octokit as never, "acme-corp", "org");
    expect(orgResult.map((r) => r.fullName)).not.toContain("acme-corp/legacy-service");
    expect(orgResult.map((r) => r.fullName)).toContain("acme-corp/acme-api");

    const userResult = await fetchRepos(octokit as never, "octocat", "user");
    expect(userResult.map((r) => r.fullName)).not.toContain("acme-corp/legacy-service");
    expect(userResult.map((r) => r.fullName)).toContain("octocat/Hello-World");
  });

  it("does not count archived repositories toward the 1000-repo REPO_CAP", async () => {
    vi.mocked(pushNotification).mockClear();

    async function* mockPaginator() {
      yield {
        data: Array.from({ length: 100 }, (_, i) => ({
          owner: { login: "org" },
          name: `archived-${i}`,
          full_name: `org/archived-${i}`,
          pushed_at: "2026-01-01T00:00:00Z",
          fork: false,
          archived: true,
        })),
      };
      yield {
        data: Array.from({ length: 50 }, (_, i) => ({
          owner: { login: "org" },
          name: `active-${i}`,
          full_name: `org/active-${i}`,
          pushed_at: "2026-01-02T00:00:00Z",
          fork: i % 2 === 0,
          archived: false,
        })),
      };
    }

    const octokit = makeBasicOctokit();
    octokit.paginate.iterator.mockImplementation((() => mockPaginator()) as never);

    const result = await fetchRepos(octokit as never, "org", "org");

    expect(result).toHaveLength(50);
    expect(result.every((r) => r.name.startsWith("active-"))).toBe(true);
    expect(result[0].isFork).toBe(true);
    expect(result[1].isFork).toBe(false);
    expect(pushNotification).not.toHaveBeenCalled();
  });

  // VALID_REPO_NAME is not exported. It is exercised indirectly via buildRepoQualifiers
  // (called inside fetchIssuesAndPullRequests). Invalid repo names are silently
  // filtered from the GraphQL query qualifiers. No additional test added here.
});

// ── discoverUpstreamRepos ─────────────────────────────────────────────────────

describe("discoverUpstreamRepos", () => {
  it("includes archived:false in both issue and PR GraphQL search queries", async () => {
    const queries: string[] = [];
    const octokit = makeOctokit(
      async () => ({ data: {}, headers: {} }),
      async (_query: string, variables: unknown) => {
        const vars = variables as { q?: string };
        if (vars.q) queries.push(vars.q);
        return {
          search: {
            issueCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                databaseId: 101,
                id: "I_kwDO101",
                number: 1,
                title: "Upstream issue",
                state: "OPEN",
                url: "https://github.com/upstream/repo/issues/1",
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-02T00:00:00Z",
                author: { login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/u/1" },
                labels: { nodes: [] },
                assignees: { nodes: [] },
                repository: { nameWithOwner: "upstream/repo" },
                comments: { totalCount: 0 },
              },
            ],
          },
          rateLimit: { limit: 5000, remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() },
        };
      }
    );

    const result = await discoverUpstreamRepos(
      octokit as never,
      "octocat",
      new Set(["octocat/Hello-World"])
    );

    expect(queries).toContain("is:issue is:open archived:false involves:octocat");
    expect(queries).toContain("is:pr is:open archived:false involves:octocat");
    expect(result).toEqual([
      { owner: "upstream", name: "repo", fullName: "upstream/repo" },
    ]);
  });
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
    expect(result?.login).toBe("dependabot");
  });

  it("accepts another bot login — khepri-bot[bot] normalized to khepri-bot", async () => {
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
    expect(result?.login).toBe("khepri-bot");
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

  it("strips [Bot] case-insensitively and tries base login first", async () => {
    const octokit = makeUserOctokit({
      login: "user",
      avatar_url: "https://avatars.githubusercontent.com/u/1",
      name: null,
      type: "User",
    });
    const result = await validateGitHubUser(octokit as never, "user[Bot]");
    expect(result).not.toBeNull();
    expect(result?.login).toBe("user");
  });

  it("returns null for user[bot][bot] (base 'user[bot]' validated but both API calls 404)", async () => {
    const octokit = makeOctokit(async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });
    const result = await validateGitHubUser(octokit as never, "user[bot][bot]");
    expect(result).toBeNull();
  });

  it("strips [bot] from API response login for storage normalization", async () => {
    const octokit = makeUserOctokit({
      login: "khepri-bot[bot]",
      avatar_url: "https://avatars.githubusercontent.com/u/1",
      name: null,
      type: "Bot",
    });
    const result = await validateGitHubUser(octokit as never, "khepri-bot[bot]");
    expect(result).not.toBeNull();
    expect(result?.login).toBe("khepri-bot");
    expect(result?.type).toBe("bot");
  });

  it("falls back to [bot] suffix when base login returns 404", async () => {
    let callCount = 0;
    const octokit = makeOctokit(async (_url: string, opts: unknown) => {
      const { username } = opts as { username: string };
      callCount++;
      if (!username.endsWith("[bot]")) {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      }
      return {
        data: {
          login: "khepri-bot[bot]",
          avatar_url: "https://avatars.githubusercontent.com/u/99",
          name: null,
          type: "Bot",
        },
      };
    });
    const result = await validateGitHubUser(octokit as never, "khepri-bot");
    expect(callCount).toBe(2);
    expect(result).not.toBeNull();
    expect(result?.login).toBe("khepri-bot");
    expect(result?.type).toBe("bot");
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
    const octokit = makeOctokit(async () => ({ data: {} }), async () => ({}));
    const result = await fetchIssuesAndPullRequests(
      octokit as never,
      [],
      "octocat",
      { monitoredRepos: [{ owner: "org", name: "monitored", fullName: "org/monitored" }] }
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

    const monitoredRepo = { owner: "org", name: "monitored", fullName: "org/monitored" };
    await fetchIssuesAndPullRequests(
      octokit as never,
      [monitoredRepo],
      "octocat",
      { monitoredRepos: [{ owner: "org", name: "monitored", fullName: "org/monitored" }] }
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
      state: "OPEN",
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

    const result = await fetchIssuesAndPullRequests(
      octokit as never,
      [repo],
      "octocat",
      // all repos monitored
      { monitoredRepos: [{ owner: "org", name: "repo1", fullName: "org/repo1" }] }
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
    state: "OPEN",
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
    state: "OPEN",
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
    const octokit = makeOctokit(
      async () => ({ data: {}, headers: {} }),
      async (_query: string, variables: unknown) => {
        const vars = variables as Record<string, unknown>;
        // Unfiltered search for monitored repo returns monitoredIssueNode
        if (typeof vars.issueQ === "string" && !vars.issueQ.includes("involves:")) {
          return {
            issues: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [monitoredIssueNode] },
            prs: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            rateLimit: { limit: 5000, remaining: 4990, resetAt: new Date(Date.now() + 3600000).toISOString() },
          };
        }
        // Bot tracked user search on normal repos returns botIssueNode
        if (typeof vars.issueQ === "string" && vars.issueQ.includes("involves:dependabot")) {
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
      { trackedUsers: [botUser], monitoredRepos: [{ owner: "org", name: "monitored", fullName: "org/monitored" }] }
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
      state: "OPEN",
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

    const result = await fetchIssuesAndPullRequests(
      octokit as never,
      [monitoredRepo],
      "octocat",
      { monitoredRepos: [{ owner: "org", name: "monitored", fullName: "org/monitored" }] }
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

    const result = await fetchIssuesAndPullRequests(
      octokit as never,
      [monitoredRepo],
      "octocat",
      { monitoredRepos: [{ owner: "org", name: "monitored", fullName: "org/monitored" }] }
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
      state: "OPEN",
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

    const result = await fetchIssuesAndPullRequests(
      octokit as never,
      [monitoredRepo],
      "octocat",
      { monitoredRepos: [{ owner: "org", name: "monitored", fullName: "org/monitored" }] }
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

    await fetchIssuesAndPullRequests(
      octokit as never,
      [repo],
      "octocat",
      // all repos monitored
      { trackedUsers: [botUser], monitoredRepos: [{ owner: "org", name: "repo1", fullName: "org/repo1" }] }
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
      state: "OPEN",
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
    const result = await fetchIssuesAndPullRequests(
      octokit as never,
      [repo],
      "octocat",
      // all repos monitored
      { onLightData, monitoredRepos: [{ owner: "org", name: "repo1", fullName: "org/repo1" }] }
    );

    // onLightData NOT called (main user search skipped, unfiltered results come after)
    expect(onLightData).not.toHaveBeenCalled();
    // But final result still has the issue
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].id).toBe(5001);
  });
});

// ── Error-path rateLimit extraction calls updateGraphqlRateLimit ──────────────

describe("error-path rateLimit extraction — updateGraphqlRateLimit called", () => {
  const mockResetAt = "2026-04-23T12:00:00Z";

  function makeGraphqlError(rateLimitOverride?: object) {
    const rateLimit = rateLimitOverride ?? { limit: 5000, remaining: 100, resetAt: mockResetAt };
    return Object.assign(new Error("GraphQL partial error"), {
      data: { rateLimit },
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("fetchPREnrichment error with partial rateLimit calls updateGraphqlRateLimit", async () => {
    const githubModule = await import("../../src/app/services/github");
    const updateSpy = vi.spyOn(githubModule, "updateGraphqlRateLimit");

    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async () => { throw makeGraphqlError(); }
    );

    await fetchPREnrichment(
      octokit as never,
      ["PR_kwDOtest001"]
    );

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5000, remaining: 100, resetAt: mockResetAt })
    );
  });

  it("fetchHotPRStatus rejected batch with rateLimit calls updateGraphqlRateLimit", async () => {
    const githubModule = await import("../../src/app/services/github");
    const updateSpy = vi.spyOn(githubModule, "updateGraphqlRateLimit");

    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async () => { throw makeGraphqlError(); }
    );

    await fetchHotPRStatus(
      octokit as never,
      ["PR_kwDOtest001"]
    );

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5000, remaining: 100, resetAt: mockResetAt })
    );
  });

  it("fetchPREnrichment second batch error with rateLimit calls updateGraphqlRateLimit", async () => {
    const githubModule = await import("../../src/app/services/github");
    const updateSpy = vi.spyOn(githubModule, "updateGraphqlRateLimit");

    const singleErrOctokit = makeOctokit(
      async () => ({ data: {} }),
      async () => { throw makeGraphqlError({ limit: 5000, remaining: 42, resetAt: mockResetAt }); }
    );

    await fetchPREnrichment(singleErrOctokit as never, ["PR_kwDOtest002"]);

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5000, remaining: 42, resetAt: mockResetAt })
    );
  });
});

// ── fetchPREnrichment — autoMergeMethod, viewerLatestReviewState, viewerReviewRequested ──

describe("fetchPREnrichment — autoMergeMethod and viewer review fields", () => {
  it("maps MERGE, SQUASH, REBASE, unknown autoMergeMethod, viewerLatestReviewState, and viewerReviewRequested", async () => {
    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async () => ({
        nodes: [
          {
            databaseId: 101,
            headRefOid: "1111111111111111111111111111111111111111",
            headRepository: null,
            mergeStateStatus: "CLEAN",
            assignees: { nodes: [] },
            reviewRequests: { nodes: [] },
            latestReviews: { totalCount: 1, nodes: [] },
            additions: 10,
            deletions: 2,
            changedFiles: 1,
            comments: { totalCount: 0 },
            reviewThreads: { totalCount: 0 },
            statusCheckRollup: { state: "SUCCESS" },
            autoMergeRequest: { mergeMethod: "SQUASH" },
            viewerLatestReview: { state: "CHANGES_REQUESTED" },
            viewerLatestReviewRequest: { id: "RR_kwDOtest101" },
          },
          {
            databaseId: 102,
            headRefOid: "2222222222222222222222222222222222222222",
            headRepository: null,
            mergeStateStatus: "CLEAN",
            assignees: { nodes: [] },
            reviewRequests: { nodes: [] },
            latestReviews: { totalCount: 0, nodes: [] },
            additions: 1,
            deletions: 1,
            changedFiles: 1,
            comments: { totalCount: 0 },
            reviewThreads: { totalCount: 0 },
            statusCheckRollup: null,
            autoMergeRequest: { mergeMethod: "MERGE" },
            viewerLatestReview: { state: "APPROVED" },
            viewerLatestReviewRequest: null,
          },
          {
            databaseId: 103,
            headRefOid: "3333333333333333333333333333333333333333",
            headRepository: null,
            mergeStateStatus: "CLEAN",
            assignees: { nodes: [] },
            reviewRequests: { nodes: [] },
            latestReviews: { totalCount: 0, nodes: [] },
            additions: 1,
            deletions: 1,
            changedFiles: 1,
            comments: { totalCount: 0 },
            reviewThreads: { totalCount: 0 },
            statusCheckRollup: null,
            autoMergeRequest: { mergeMethod: "REBASE" },
            viewerLatestReview: { state: "UNKNOWN_STATE" },
            viewerLatestReviewRequest: null,
          },
          {
            databaseId: 104,
            headRefOid: "4444444444444444444444444444444444444444",
            headRepository: null,
            mergeStateStatus: "CLEAN",
            assignees: { nodes: [] },
            reviewRequests: { nodes: [] },
            latestReviews: { totalCount: 0, nodes: [] },
            additions: 1,
            deletions: 1,
            changedFiles: 1,
            comments: { totalCount: 0 },
            reviewThreads: { totalCount: 0 },
            statusCheckRollup: null,
            autoMergeRequest: { mergeMethod: "INVALID" },
            viewerLatestReview: null,
            viewerLatestReviewRequest: null,
          },
        ],
        rateLimit: { limit: 5000, remaining: 4990, resetAt: "2026-04-23T12:00:00Z" },
      })
    );

    const { enrichments } = await fetchPREnrichment(octokit as never, ["PR_1", "PR_2", "PR_3", "PR_4"]);

    expect(enrichments.get(101)).toMatchObject({
      autoMergeMethod: "SQUASH",
      viewerLatestReviewState: "CHANGES_REQUESTED",
      viewerReviewRequested: true,
    });
    expect(enrichments.get(102)).toMatchObject({
      autoMergeMethod: "MERGE",
      viewerLatestReviewState: "APPROVED",
      viewerReviewRequested: false,
    });
    expect(enrichments.get(103)).toMatchObject({
      autoMergeMethod: "REBASE",
      viewerLatestReviewState: null,
      viewerReviewRequested: false,
    });
    expect(enrichments.get(104)).toMatchObject({
      autoMergeMethod: null,
      viewerLatestReviewState: null,
      viewerReviewRequested: false,
    });
  });
});

// ── approvePullRequest ────────────────────────────────────────────────────────

describe("approvePullRequest", () => {
  const validSha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

  it("executes APPROVE_PR_MUTATION with commitOID, retries: 0, updates rateLimit, and returns normalized state + reviewDecision", async () => {
    const githubModule = await import("../../src/app/services/github");
    const updateSpy = vi.spyOn(githubModule, "updateGraphqlRateLimit");

    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async () => ({
        addPullRequestReview: {
          pullRequestReview: {
            state: "APPROVED",
            pullRequest: {
              reviewDecision: "APPROVED",
            },
          },
        },
        rateLimit: { cost: 1, limit: 5000, remaining: 4988, resetAt: "2026-04-23T12:00:00Z" },
      })
    );

    const result = await approvePullRequest(octokit as never, "PR_kwDOtest0042", validSha);

    expect(octokit.graphql).toHaveBeenCalledWith(APPROVE_PR_MUTATION, {
      pullRequestId: "PR_kwDOtest0042",
      commitOID: validSha,
      request: { apiSource: "approvePR", retries: 0 },
    });
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5000, remaining: 4988, resetAt: "2026-04-23T12:00:00Z" })
    );
    expect(result).toEqual({
      state: "APPROVED",
      reviewDecision: "APPROVED",
    });
  });

  it("rejects invalid pullRequestId or commitOID before calling octokit.graphql", async () => {
    const octokit = makeOctokit(async () => ({ data: {} }));

    await expect(
      approvePullRequest(octokit as never, "bad!id", validSha)
    ).rejects.toThrow(/Invalid pullRequestId/);

    await expect(
      approvePullRequest(octokit as never, "PR_kwDOtest0042", "not-a-40-char-sha")
    ).rejects.toThrow(/Invalid commitOID/);

    expect(octokit.graphql).not.toHaveBeenCalled();
  });

  it("throws when GitHub response does not confirm APPROVED review state", async () => {
    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async () => ({
        addPullRequestReview: {
          pullRequestReview: {
            state: "PENDING",
            pullRequest: { reviewDecision: "REVIEW_REQUIRED" },
          },
        },
      })
    );

    await expect(
      approvePullRequest(octokit as never, "PR_kwDOtest0042", validSha)
    ).rejects.toThrow("GitHub did not confirm pull request approval");
  });
});

// ── markPullRequestReady ──────────────────────────────────────────────────────

describe("markPullRequestReady", () => {
  it("executes MARK_PR_READY_MUTATION with retries: 0, updates rateLimit, and returns draft: false + reviewDecision", async () => {
    const githubModule = await import("../../src/app/services/github");
    const updateSpy = vi.spyOn(githubModule, "updateGraphqlRateLimit");

    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async () => ({
        markPullRequestReadyForReview: {
          pullRequest: {
            isDraft: false,
            reviewDecision: "REVIEW_REQUIRED",
          },
        },
        rateLimit: { cost: 1, limit: 5000, remaining: 4987, resetAt: "2026-04-23T12:00:00Z" },
      })
    );

    const result = await markPullRequestReady(octokit as never, "PR_kwDOtest0042");

    expect(octokit.graphql).toHaveBeenCalledWith(MARK_PR_READY_MUTATION, {
      pullRequestId: "PR_kwDOtest0042",
      request: { apiSource: "markPRReady", retries: 0 },
    });
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5000, remaining: 4987, resetAt: "2026-04-23T12:00:00Z" })
    );
    expect(result).toEqual({
      draft: false,
      reviewDecision: "REVIEW_REQUIRED",
    });
  });

  it("rejects invalid pullRequestId before calling octokit.graphql", async () => {
    const octokit = makeOctokit(async () => ({ data: {} }));

    await expect(
      markPullRequestReady(octokit as never, "bad!id")
    ).rejects.toThrow("Invalid pullRequestId");

    expect(octokit.graphql).not.toHaveBeenCalled();
  });

  it("throws when pullRequest is null or isDraft is true", async () => {
    const octokitStillDraft = makeOctokit(
      async () => ({ data: {} }),
      async () => ({
        markPullRequestReadyForReview: {
          pullRequest: {
            isDraft: true,
            reviewDecision: null,
          },
        },
      })
    );

    await expect(
      markPullRequestReady(octokitStillDraft as never, "PR_kwDOtest0042")
    ).rejects.toThrow("GitHub did not confirm pull request is ready for review");

    const octokitNullPR = makeOctokit(
      async () => ({ data: {} }),
      async () => ({
        markPullRequestReadyForReview: {
          pullRequest: null,
        },
      })
    );

    await expect(
      markPullRequestReady(octokitNullPR as never, "PR_kwDOtest0042")
    ).rejects.toThrow("GitHub did not confirm pull request is ready for review");
  });
});

// ── fetchPREnrichment — 25-node chunking, binary splitting, and light fallback ──

describe("fetchPREnrichment — 25-node chunking, binary splitting, and light fallback", () => {
  beforeEach(() => {
    vi.mocked(Sentry.captureException).mockClear();
    resetPREnrichmentCache();
  });

  function buildHeavyNode(dbId: number, nodeId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: nodeId,
      databaseId: dbId,
      headRefOid: `sha-${dbId}`,
      headRepository: { owner: { login: "octocat" }, nameWithOwner: "octocat/Hello-World" },
      mergeStateStatus: "CLEAN",
      assignees: { nodes: [{ login: "octocat" }] },
      reviewRequests: { nodes: [] },
      latestReviews: { totalCount: 1, nodes: [{ author: { login: "reviewer1" } }] },
      additions: 15,
      deletions: 3,
      changedFiles: 2,
      comments: { totalCount: 1 },
      reviewThreads: { totalCount: 0 },
      statusCheckRollup: { state: "SUCCESS" },
      autoMergeRequest: null,
      viewerLatestReview: null,
      viewerLatestReviewRequest: null,
      ...overrides,
    };
  }

  it("chunks 60 node IDs into [25, 25, 10] batches using HEAVY_BACKFILL_BATCH_SIZE = 25", async () => {
    expect(HEAVY_BACKFILL_BATCH_SIZE).toBe(25);
    expect(MIN_SPLIT_BATCH_SIZE).toBe(6);

    const batchSizes: number[] = [];
    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async (_query: string, variables?: unknown) => {
        const ids = (variables as { ids: string[] }).ids;
        batchSizes.push(ids.length);
        return {
          nodes: ids.map((id) => {
            const num = Number(id.replace("PR_", ""));
            return buildHeavyNode(num, id);
          }),
          rateLimit: { limit: 5000, remaining: 4990, resetAt: "2026-04-23T12:00:00Z" },
        };
      }
    );

    const nodeIds = Array.from({ length: 60 }, (_, i) => `PR_${i + 1}`);
    const { enrichments, errors } = await fetchPREnrichment(octokit as never, nodeIds);

    expect(batchSizes).toEqual([25, 25, 10]);
    expect(enrichments.size).toBe(60);
    expect(errors).toEqual([]);
  });

  it("recursively splits a failing 25-node batch (25 -> 12/13 -> 6/6/6/7) on retryable errors, recovering all 25 enrichments with zero errors or Sentry calls", async () => {
    const sentrySpy = vi.mocked(Sentry.captureException);
    const callBatchSizes: number[] = [];
    const allRetriesFlags: Array<number | undefined> = [];

    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async (_query: string, variables?: unknown) => {
        const vars = variables as { ids: string[]; request?: { retries?: number } };
        const ids = vars.ids;
        callBatchSizes.push(ids.length);
        allRetriesFlags.push(vars.request?.retries);
        if (ids.length > MIN_SPLIT_BATCH_SIZE) {
          throw Object.assign(new Error("Bad Gateway"), { status: 502 });
        }
        return {
          nodes: ids.map((id) => {
            const num = Number(id.replace("PR_", ""));
            return buildHeavyNode(num, id);
          }),
        };
      }
    );

    const nodeIds = Array.from({ length: 25 }, (_, i) => `PR_${i + 1}`);
    const { enrichments, errors } = await fetchPREnrichment(octokit as never, nodeIds);

    expect(enrichments.size).toBe(25);
    expect(errors).toEqual([]);
    expect(sentrySpy).not.toHaveBeenCalled();
    // Both top-level and split sub-batches must pass retries: 0 so a 502/504 splits immediately
    // without @octokit/plugin-retry re-running the unsplit 25-node batch first
    expect(allRetriesFlags.length).toBeGreaterThan(0);
    expect(allRetriesFlags.every((r) => r === 0)).toBe(true);
    expect(callBatchSizes).toContain(25);
    expect(callBatchSizes).toContain(12);
    expect(callBatchSizes).toContain(13);
  });

  it.each([
    [
      "status-500 RequestError with a TypeError cause",
      () => Object.assign(new Error("Failed to fetch", { cause: new TypeError("Failed to fetch") }), { status: 500 }),
    ],
    ["bare TypeError", () => new TypeError("Failed to fetch")],
  ])(
    "splits a batch that fails with 'Failed to fetch' (CORS-masked gateway 502/504) as a %s",
    async (_label, makeError) => {
      const heavySizes: number[] = [];
      const octokit = makeOctokit(
        async () => ({ data: {} }),
        async (query: string, variables?: unknown) => {
          const ids = (variables as { ids: string[] }).ids;
          if (query.includes("statusCheckRollup")) {
            heavySizes.push(ids.length);
            if (ids.length > MIN_SPLIT_BATCH_SIZE) throw makeError();
          }
          return { nodes: ids.map((id) => buildHeavyNode(Number(id.replace("PR_", "")), id)) };
        }
      );

      const nodeIds = Array.from({ length: 25 }, (_, i) => `PR_${i + 1}`);
      const { enrichments, errors } = await fetchPREnrichment(octokit as never, nodeIds);

      expect(heavySizes).toContain(12);
      expect(heavySizes).toContain(13);
      expect(enrichments.size).toBe(25);
      expect(enrichments.get(1)?.checkStatusStale).toBeFalsy();
      expect(errors).toEqual([]);
    }
  );

  it("still splits when the heavy request hit the per-attempt fetch timeout (TimeoutError cause)", async () => {
    const callBatchSizes: number[] = [];
    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async (_query: string, variables?: unknown) => {
        const ids = (variables as { ids: string[] }).ids;
        callBatchSizes.push(ids.length);
        if (ids.length > MIN_SPLIT_BATCH_SIZE) {
          throw Object.assign(
            new Error("signal timed out", { cause: new DOMException("signal timed out", "TimeoutError") }),
            { status: 500 },
          );
        }
        return { nodes: ids.map((id) => buildHeavyNode(Number(id.replace("PR_", "")), id)) };
      }
    );

    const nodeIds = Array.from({ length: 25 }, (_, i) => `PR_${i + 1}`);
    const { enrichments, errors } = await fetchPREnrichment(octokit as never, nodeIds);

    expect(callBatchSizes).toContain(12);
    expect(callBatchSizes).toContain(13);
    expect(enrichments.size).toBe(25);
    expect(errors).toEqual([]);
  });

  it("stops splitting once SPLIT_SUPPRESSION_BATCH_THRESHOLD batches have failed with no heavy node resolved", async () => {
    expect(SPLIT_SUPPRESSION_BATCH_THRESHOLD).toBe(2);
    const heavySizes: number[] = [];
    const lightSizes: number[] = [];
    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async (query: string, variables?: unknown) => {
        const ids = (variables as { ids: string[] }).ids;
        if (query.includes("statusCheckRollup")) {
          heavySizes.push(ids.length);
          throw Object.assign(new Error("Bad Gateway"), { status: 502 });
        }
        lightSizes.push(ids.length);
        return { nodes: ids.map((id) => buildHeavyNode(Number(id.replace("PR_", "")), id)) };
      }
    );

    const nodeIds = Array.from({ length: 75 }, (_, i) => `PR_${i + 1}`);
    const { enrichments, errors } = await fetchPREnrichment(octokit as never, nodeIds);

    // Batch 1 fails first and splits once (12/13); batches 2 and 3 reach the threshold and
    // go straight to light, as do batch 1's halves. No second-level splits occur.
    expect(heavySizes.filter((n) => n === 25)).toHaveLength(3);
    expect(heavySizes.filter((n) => n < 12)).toEqual([]);
    expect(heavySizes).toHaveLength(5);
    expect(lightSizes).toHaveLength(4);
    expect(lightSizes.reduce((a, b) => a + b, 0)).toBe(75);
    expect(enrichments.size).toBe(75);
    expect(errors).toHaveLength(3);
    expect(errors.every((e) => e.retryable)).toBe(true);
  });

  it("keeps splitting failing batches once any heavy node has resolved in the same call", async () => {
    const heavySizes: number[] = [];
    const lightSizes: number[] = [];
    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async (query: string, variables?: unknown) => {
        const ids = (variables as { ids: string[] }).ids;
        if (query.includes("statusCheckRollup")) {
          heavySizes.push(ids.length);
          // Batch 1 (PR_1..PR_25) succeeds; batches 2 and 3 fail until split down to <= 6
          const inFirstBatch = Number(ids[0].replace("PR_", "")) <= 25;
          if (!inFirstBatch && ids.length > MIN_SPLIT_BATCH_SIZE) {
            throw Object.assign(new Error("Bad Gateway"), { status: 502 });
          }
          return { nodes: ids.map((id) => buildHeavyNode(Number(id.replace("PR_", "")), id)) };
        }
        lightSizes.push(ids.length);
        return { nodes: ids.map((id) => buildHeavyNode(Number(id.replace("PR_", "")), id)) };
      }
    );

    const nodeIds = Array.from({ length: 75 }, (_, i) => `PR_${i + 1}`);
    const { enrichments, errors } = await fetchPREnrichment(octokit as never, nodeIds);

    // Batch 3 is the second failing batch but still splits because batch 1 resolved heavy nodes
    expect(heavySizes.filter((n) => n < 12).length).toBeGreaterThan(0);
    expect(lightSizes).toEqual([]);
    expect(enrichments.size).toBe(75);
    expect(errors).toEqual([]);
  });

  it("does not count light-fallback nodes as resolved heavy nodes when deciding whether to split", async () => {
    const batch3HeavySizes: number[] = [];
    let lightCalls = 0;
    let releaseBatch3!: () => void;
    const batch3Released = new Promise<void>((resolve) => { releaseBatch3 = resolve; });
    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async (query: string, variables?: unknown) => {
        const ids = (variables as { ids: string[] }).ids;
        if (query.includes("statusCheckRollup")) {
          if (ids.includes("PR_51")) {
            batch3HeavySizes.push(ids.length);
            // Hold batch 3's failure until batches 1-2 have fallen back to light and been ingested
            await batch3Released;
          }
          throw Object.assign(new Error("Bad Gateway"), { status: 502 });
        }
        lightCalls++;
        // Batch 1 splits once (2 light leaves) and batch 2 goes straight to light: 3 light calls
        if (lightCalls === 3) setTimeout(releaseBatch3, 0);
        return { nodes: ids.map((id) => buildHeavyNode(Number(id.replace("PR_", "")), id)) };
      }
    );

    const nodeIds = Array.from({ length: 75 }, (_, i) => `PR_${i + 1}`);
    const { enrichments } = await fetchPREnrichment(octokit as never, nodeIds);

    expect(lightCalls).toBe(4);
    expect(batch3HeavySizes).toEqual([25]);
    expect(enrichments.size).toBe(75);
  });

  it("short-circuits immediately without splitting or calling LIGHT_PR_BACKFILL_QUERY when a batch fails with a non-retryable 401/403 status", async () => {
    const sentrySpy = vi.mocked(Sentry.captureException);
    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async () => {
        throw Object.assign(new Error("Resource not accessible by integration"), { status: 403 });
      }
    );

    const nodeIds = Array.from({ length: 25 }, (_, i) => `PR_${i + 1}`);
    const { enrichments, errors } = await fetchPREnrichment(octokit as never, nodeIds);

    expect(octokit.graphql).toHaveBeenCalledTimes(1);
    expect(enrichments.size).toBe(0);
    expect(sentrySpy).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([
      expect.objectContaining({
        repo: "backfill-batch-1/1",
        statusCode: 403,
        retryable: false,
      }),
    ]);
  });

  it("falls back to LIGHT_PR_BACKFILL_QUERY when a <= 6 leaf batch fails HEAVY_PR_BACKFILL_QUERY, setting checkStatusStale: true and preserving prior checkStatus in fallbackToPreviousEnrichment", async () => {
    const sentrySpy = vi.mocked(Sentry.captureException);
    const queriesExecuted: string[] = [];

    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async (query: string, variables?: unknown) => {
        queriesExecuted.push(query);
        const ids = (variables as { ids: string[] }).ids;
        if (query.includes("statusCheckRollup")) {
          throw new TypeError("Failed to fetch");
        }
        // Light query omits mergeStateStatus and statusCheckRollup
        return {
          nodes: ids.map((id) => {
            const num = Number(id.replace("PR_", ""));
            return {
              id,
              databaseId: num,
              headRefOid: `sha-light-${num}`,
              headRepository: { owner: { login: "octocat" }, nameWithOwner: "octocat/Hello-World" },
              assignees: { nodes: [{ login: "octocat" }] },
              reviewRequests: { nodes: [] },
              latestReviews: { totalCount: 2, nodes: [{ author: { login: "reviewer1" } }] },
              additions: 42,
              deletions: 7,
              changedFiles: 4,
              comments: { totalCount: 5 },
              reviewThreads: { totalCount: 1 },
              autoMergeRequest: null,
              viewerLatestReview: { state: "APPROVED" },
              viewerLatestReviewRequest: null,
            };
          }),
        };
      }
    );

    const { enrichments, errors } = await fetchPREnrichment(octokit as never, ["PR_1", "PR_2"]);

    expect(queriesExecuted).toHaveLength(2);
    expect(queriesExecuted[0]).toContain("statusCheckRollup");
    expect(queriesExecuted[1]).not.toContain("statusCheckRollup");
    expect(sentrySpy).toHaveBeenCalledTimes(1);

    const e1 = enrichments.get(1);
    expect(e1).toBeDefined();
    expect(e1!.checkStatus).toBeNull();
    expect(e1!.checkStatusStale).toBe(true);
    expect(e1!.additions).toBe(42);
    expect(e1!.headSha).toBe("sha-light-1");
    expect(errors).toEqual([
      expect.objectContaining({
        repo: "backfill-batch-1/1",
        retryable: true,
      }),
    ]);

    // Verify fallbackToPreviousEnrichment restores prior non-stale checkStatus when available
    const prevPR1 = makePullRequest({
      id: 1,
      enriched: true,
      checkStatus: "success",
      additions: 10,
    });
    const nextPR1 = makePullRequest({
      id: 1,
      enriched: true,
      checkStatus: null,
      checkStatusStale: true,
      additions: 42,
    });
    const nextPR2ColdStart = makePullRequest({
      id: 2,
      enriched: true,
      checkStatus: null,
      checkStatusStale: true,
      additions: 42,
    });

    const resolved = fallbackToPreviousEnrichment([prevPR1], [nextPR1, nextPR2ColdStart]);
    expect(resolved[0].checkStatus).toBe("success");
    expect(resolved[0].checkStatusStale).toBe(false);
    expect(resolved[0].additions).toBe(42);

    // Cold-start PR with no prior non-stale enrichment retains checkStatusStale: true
    expect(resolved[1].checkStatus).toBeNull();
    expect(resolved[1].checkStatusStale).toBe(true);
  });

  it("salvages partial err.data.nodes on heavy/light failures and deduplicates batch errors across split leaves", async () => {
    const ids = Array.from({ length: 14 }, (_, i) => `PR_node_${i + 1}`);
    const calls: { isLight: boolean; ids: string[] }[] = [];

    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async (query: string, variables?: unknown) => {
        const vars = (variables ?? {}) as { ids: string[] };
        const isLight = !query.includes("statusCheckRollup");
        calls.push({ isLight, ids: vars.ids });

        if (!isLight && vars.ids.length === 14) {
          // Top-level 14-node batch fails with partial data resolving PR_node_1 and PR_node_2,
          // leaving 12 unresolved IDs which split into 6 + 6 leaves
          throw Object.assign(new Error("Partial heavy timeout"), {
            status: 502,
            data: {
              nodes: [
                {
                  id: "PR_node_1",
                  databaseId: 1,
                  headRefOid: "sha-1",
                  headRepository: null,
                  mergeStateStatus: "CLEAN",
                  assignees: { nodes: [] },
                  reviewRequests: { nodes: [] },
                  latestReviews: { totalCount: 0, nodes: [] },
                  additions: 5,
                  deletions: 1,
                  changedFiles: 1,
                  comments: { totalCount: 0 },
                  reviewThreads: { totalCount: 0 },
                  autoMergeRequest: null,
                  viewerLatestReview: null,
                  viewerLatestReviewRequest: null,
                  statusCheckRollup: { state: "SUCCESS" },
                },
                {
                  id: "PR_node_2",
                  databaseId: 2,
                  headRefOid: "sha-2",
                  headRepository: null,
                  mergeStateStatus: "CLEAN",
                  assignees: { nodes: [] },
                  reviewRequests: { nodes: [] },
                  latestReviews: { totalCount: 0, nodes: [] },
                  additions: 6,
                  deletions: 2,
                  changedFiles: 1,
                  comments: { totalCount: 0 },
                  reviewThreads: { totalCount: 0 },
                  autoMergeRequest: null,
                  viewerLatestReview: null,
                  viewerLatestReviewRequest: null,
                  statusCheckRollup: { state: "SUCCESS" },
                },
              ],
            },
          });
        }

        if (!isLight) {
          // Both 6-node leaf sub-batches fail heavy query
          throw Object.assign(new Error("Leaf heavy timeout"), { status: 502 });
        }

        // Light fallback rejects with partial data on the first leaf and succeeds on the second
        const firstId = vars.ids[0];
        const dbId = Number(firstId.replace("PR_node_", ""));
        const lightNode = {
          id: firstId,
          databaseId: dbId,
          headRefOid: `sha-${dbId}`,
          headRepository: null,
          assignees: { nodes: [] },
          reviewRequests: { nodes: [] },
          latestReviews: { totalCount: 0, nodes: [] },
          additions: 20,
          deletions: 4,
          changedFiles: 2,
          comments: { totalCount: 0 },
          reviewThreads: { totalCount: 0 },
          autoMergeRequest: null,
          viewerLatestReview: null,
          viewerLatestReviewRequest: null,
        };
        if (firstId === "PR_node_3") {
          throw Object.assign(new Error("Light partial error"), {
            status: 502,
            data: { nodes: [lightNode] },
          });
        }
        return { nodes: [lightNode] };
      }
    );

    const { enrichments, errors } = await fetchPREnrichment(octokit as never, ids);
    // PR_node_1 and PR_node_2 salvaged from top-level heavy partial data and excluded from split retries
    expect(enrichments.get(1)?.checkStatus).toBe("success");
    expect(enrichments.get(2)?.checkStatus).toBe("success");
    expect(calls[1].ids).not.toContain("PR_node_1");
    expect(calls[1].ids).not.toContain("PR_node_2");
    // PR_node_3 salvaged from lightErr.data.nodes with checkStatusStale: true
    expect(enrichments.get(3)?.checkStatusStale).toBe(true);
    expect(enrichments.get(9)?.checkStatusStale).toBe(true);
    // Only 1 error pushed for the top-level batch despite both 6-node leaves failing
    expect(errors).toHaveLength(1);
    expect(errors[0].repo).toBe("backfill-batch-1/1");
  });

  it("parses direct PullRequest.statusCheckRollup.state and handles null nested collections/counts without TypeError", async () => {
    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async (query: string) => {
        expect(query).toContain("statusCheckRollup { state contexts { checkRunCountsByState { state count } } }");
        expect(query).not.toContain("commits(last: 1)");
        return {
          nodes: [
            {
              id: "PR_null_fields",
              databaseId: 301,
              headRefOid: "sha-301",
              headRepository: { owner: null, nameWithOwner: "fork/repo" },
              mergeStateStatus: "CLEAN",
              assignees: { nodes: null },
              reviewRequests: { nodes: null },
              latestReviews: { totalCount: null, nodes: null },
              additions: null,
              deletions: null,
              changedFiles: null,
              comments: null,
              reviewThreads: { totalCount: null },
              autoMergeRequest: null,
              viewerLatestReview: null,
              viewerLatestReviewRequest: null,
              statusCheckRollup: { state: "FAILURE" },
            },
            {
              id: "PR_direct_success",
              databaseId: 302,
              headRefOid: "sha-302",
              headRepository: null,
              mergeStateStatus: "CLEAN",
              assignees: null,
              reviewRequests: { nodes: [null, { requestedReviewer: null }, { requestedReviewer: { login: "Alice" } }] },
              latestReviews: { totalCount: 2, nodes: [null, { author: null }, { author: { login: "Bob" } }] },
              additions: 12,
              deletions: 3,
              changedFiles: 1,
              comments: { totalCount: 4 },
              reviewThreads: null,
              autoMergeRequest: null,
              viewerLatestReview: null,
              viewerLatestReviewRequest: null,
              statusCheckRollup: { state: "SUCCESS" },
            },
          ],
        };
      }
    );

    const { enrichments, errors } = await fetchPREnrichment(octokit as never, ["PR_null_fields", "PR_direct_success"]);
    expect(errors).toEqual([]);

    const e301 = enrichments.get(301);
    expect(e301).toBeDefined();
    expect(e301!.checkStatus).toBe("failure");
    expect(e301!.headRepository).toBeNull();
    expect(e301!.assigneeLogins).toEqual([]);
    expect(e301!.reviewerLogins).toEqual([]);
    expect(e301!.additions).toBe(0);
    expect(e301!.deletions).toBe(0);
    expect(e301!.changedFiles).toBe(0);
    expect(e301!.comments).toBe(0);
    expect(e301!.reviewThreads).toBe(0);
    expect(e301!.totalReviewCount).toBe(0);

    const e302 = enrichments.get(302);
    expect(e302).toBeDefined();
    expect(e302!.checkStatus).toBe("success");
    expect(e302!.reviewerLogins).toEqual(["alice", "bob"]);
    expect(e302!.comments).toBe(4);
    expect(e302!.reviewThreads).toBe(0);
  });

  it("classifies non-terminal statusCheckRollup into running, waiting, and pending via contexts.checkRunCountsByState and preserves all three under UNSTABLE mergeStateStatus", async () => {
    const nodes = [
      // (a) IN_PROGRESS > 0 wins over WAITING > 0 -> "running"
      buildHeavyNode(310, "PR_310", {
        statusCheckRollup: {
          state: "PENDING",
          contexts: {
            checkRunCountsByState: [
              { state: "IN_PROGRESS", count: 2 },
              { state: "WAITING", count: 1 },
            ],
          },
        },
      }),
      // (b) IN_PROGRESS === 0, WAITING > 0 -> "waiting" (agent-director/platform #42 case)
      buildHeavyNode(311, "PR_311", {
        statusCheckRollup: {
          state: "PENDING",
          contexts: {
            checkRunCountsByState: [
              { state: "IN_PROGRESS", count: 0 },
              { state: "WAITING", count: 1 },
              { state: "SUCCESS", count: 11 },
            ],
          },
        },
      }),
      // (c) IN_PROGRESS === 0, WAITING === 0, QUEUED > 0 -> "pending" (osac-project/osac #2099 case)
      buildHeavyNode(312, "PR_312", {
        statusCheckRollup: {
          state: "PENDING",
          contexts: {
            checkRunCountsByState: [
              { state: "IN_PROGRESS", count: 0 },
              { state: "WAITING", count: 0 },
              { state: "QUEUED", count: 1 },
              { state: "SUCCESS", count: 13 },
            ],
          },
        },
      }),
      // (d) PENDING StatusContext (IN_PROGRESS: 0, WAITING: 0) + mergeStateStatus: "UNSTABLE" -> "pending" (not overridden to "failure")
      buildHeavyNode(313, "PR_313", {
        mergeStateStatus: "UNSTABLE",
        statusCheckRollup: {
          state: "PENDING",
          contexts: {
            checkRunCountsByState: [
              { state: "IN_PROGRESS", count: 0 },
              { state: "WAITING", count: 0 },
            ],
          },
        },
      }),
      // (e) Bare { state: "PENDING" } without contexts -> "pending"
      buildHeavyNode(314, "PR_314", {
        statusCheckRollup: {
          state: "PENDING",
        },
      }),
      // (f1) IN_PROGRESS: 1 + mergeStateStatus: "UNSTABLE" -> "running" (not overridden to "failure")
      buildHeavyNode(315, "PR_315", {
        mergeStateStatus: "UNSTABLE",
        statusCheckRollup: {
          state: "PENDING",
          contexts: {
            checkRunCountsByState: [{ state: "IN_PROGRESS", count: 1 }],
          },
        },
      }),
      // (f2) WAITING: 1 + mergeStateStatus: "UNSTABLE" -> "waiting" (not overridden to "failure")
      buildHeavyNode(316, "PR_316", {
        mergeStateStatus: "UNSTABLE",
        statusCheckRollup: {
          state: "PENDING",
          contexts: {
            checkRunCountsByState: [{ state: "WAITING", count: 1 }],
          },
        },
      }),
      // (f3) ACTION_REQUIRED > 0 in checkRunCountsByState under PENDING rollup -> "waiting"
      buildHeavyNode(317, "PR_317", {
        statusCheckRollup: {
          state: "PENDING",
          contexts: {
            checkRunCountsByState: [{ state: "ACTION_REQUIRED", count: 1 }],
          },
        },
      }),
      // Control: terminal SUCCESS + mergeStateStatus: "UNSTABLE" -> overridden to "failure"
      buildHeavyNode(318, "PR_318", {
        mergeStateStatus: "UNSTABLE",
        statusCheckRollup: {
          state: "SUCCESS",
          contexts: {
            checkRunCountsByState: [{ state: "SUCCESS", count: 5 }],
          },
        },
      }),
    ];

    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async () => ({ nodes }),
    );

    const { enrichments, errors } = await fetchPREnrichment(
      octokit as never,
      nodes.map((n) => n.id),
    );
    expect(errors).toEqual([]);
    expect(enrichments.get(310)?.checkStatus).toBe("running");
    expect(enrichments.get(311)?.checkStatus).toBe("waiting");
    expect(enrichments.get(312)?.checkStatus).toBe("pending");
    expect(enrichments.get(313)?.checkStatus).toBe("pending");
    expect(enrichments.get(314)?.checkStatus).toBe("pending");
    expect(enrichments.get(315)?.checkStatus).toBe("running");
    expect(enrichments.get(316)?.checkStatus).toBe("waiting");
    expect(enrichments.get(317)?.checkStatus).toBe("waiting");
    expect(enrichments.get(318)?.checkStatus).toBe("failure");
  });

  it("excludes truncated node indices from err.errors[].path during partial salvage and retries 1..6 remaining IDs with HEAVY_PR_BACKFILL_QUERY", async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `PR_${i + 1}`);
    const heavyCallIds: string[][] = [];

    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async (query: string, variables?: unknown) => {
        const vars = (variables ?? {}) as { ids: string[] };
        const isHeavy = query.includes("statusCheckRollup");
        if (isHeavy) {
          heavyCallIds.push(vars.ids);
        }

        if (vars.ids.length === 9) {
          // Simulate RESOURCE_LIMITS_EXCEEDED on nodes[8]: nodes 0..7 are intact,
          // node 8 has truncated null sub-fields and is referenced in err.errors[].path.
          throw Object.assign(new Error("Resource limits exceeded"), {
            errors: [
              null,
              { path: ["rateLimit"] },
              { path: ["nodes", -1, "commits"] },
              { path: ["nodes", "8", "commits"] },
              { path: ["nodes", 8, "reviewRequests", "nodes"] },
              { path: ["nodes", 8, "commits", "nodes"] },
            ],
            data: {
              nodes: [
                ...ids.slice(0, 8).map((id, idx) =>
                  buildHeavyNode(idx + 1, id, {
                    statusCheckRollup: { state: "SUCCESS" },                  })
                ),
                {
                  id: "PR_9",
                  databaseId: 9,
                  headRefOid: "sha-9",
                  headRepository: null,
                  mergeStateStatus: "CLEAN",
                  assignees: { nodes: null },
                  reviewRequests: { nodes: null },
                  latestReviews: { totalCount: 0, nodes: null },
                  additions: 1,
                  deletions: 1,
                  changedFiles: 1,
                  comments: { totalCount: 0 },
                  reviewThreads: { totalCount: 0 },
                  statusCheckRollup: null,                },
              ],
            },
          });
        }

        // Follow-up heavy retry for the single remaining ID ["PR_9"] succeeds with real FAILURE status
        return {
          nodes: [
            buildHeavyNode(9, "PR_9", {
              headRefOid: "sha-9-fresh",
              statusCheckRollup: { state: "FAILURE" },            }),
          ],
        };
      }
    );

    const { enrichments, errors } = await fetchPREnrichment(octokit as never, ids);

    // 1st call: all 9 IDs; 2nd call: heavy retry of only ["PR_9"] (since 8 salvaged, leaving 1 <= MIN_SPLIT_BATCH_SIZE)
    expect(heavyCallIds).toEqual([ids, ["PR_9"]]);
    expect(errors).toEqual([]);
    expect(enrichments.size).toBe(9);
    expect(enrichments.get(1)?.checkStatus).toBe("success");
    // Node 9 was NOT poisoned with checkStatus: null from the truncated partial node; it got "failure" from heavy retry
    expect(enrichments.get(9)?.checkStatus).toBe("failure");
    expect(enrichments.get(9)?.headSha).toBe("sha-9-fresh");
  });

  it("enforces revision-aware headSha and updatedAt checks in fallbackToPreviousEnrichment", () => {
    // 1. Light-backfill PR (enriched: true, checkStatusStale: true) with matching headSha -> preserves prev.checkStatus
    const prevMatchingSha = makePullRequest({
      id: 10,
      enriched: true,
      headSha: "sha-same",
      updatedAt: "2026-04-20T10:00:00Z",
      checkStatus: "failure",
    });
    const nextMatchingSha = makePullRequest({
      id: 10,
      enriched: true,
      headSha: "sha-same",
      updatedAt: "2026-04-20T10:05:00Z",
      checkStatus: null,
      checkStatusStale: true,
    });
    const [resMatchingSha] = fallbackToPreviousEnrichment([prevMatchingSha], [nextMatchingSha]);
    expect(resMatchingSha.checkStatus).toBe("failure");
    expect(resMatchingSha.checkStatusStale).toBe(false);

    // 2. Light-backfill PR (enriched: true, checkStatusStale: true) with different headSha (force-push) -> clears checkStatus to null and keeps checkStatusStale: true
    const nextNewSha = makePullRequest({
      id: 10,
      enriched: true,
      headSha: "sha-new-commit",
      updatedAt: "2026-04-20T10:05:00Z",
      checkStatus: null,
      checkStatusStale: true,
    });
    const [resNewSha] = fallbackToPreviousEnrichment([prevMatchingSha], [nextNewSha]);
    expect(resNewSha.checkStatus).toBeNull();
    expect(resNewSha.checkStatusStale).toBe(true);

    // 3. Unenriched PR (enriched: false) where updatedAt changed -> carries forward heavy counts, clears headSha to "" and checkStatus to null, sets checkStatusStale: true
    const prevEnriched = makePullRequest({
      id: 20,
      enriched: true,
      headSha: "sha-old",
      updatedAt: "2026-04-20T10:00:00Z",
      checkStatus: "failure",
      additions: 55,
    });
    const nextUnenrichedUpdated = makePullRequest({
      id: 20,
      enriched: false,
      headSha: "",
      updatedAt: "2026-04-20T11:00:00Z",
      checkStatus: null,
      additions: 0,
    });
    const [resUnenrichedUpdated] = fallbackToPreviousEnrichment([prevEnriched], [nextUnenrichedUpdated]);
    expect(resUnenrichedUpdated.enriched).toBe(true);
    expect(resUnenrichedUpdated.additions).toBe(55);
    expect(resUnenrichedUpdated.headSha).toBe("");
    expect(resUnenrichedUpdated.checkStatus).toBeNull();
    expect(resUnenrichedUpdated.checkStatusStale).toBe(true);
  });
});

// ── fetchIssuesAndPullRequests — settled-PR enrichment cache ─────────────────

describe("fetchIssuesAndPullRequests — settled-PR enrichment cache", () => {
  function makeLightPR(overrides: Record<string, unknown> = {}) {
    return {
      id: "PR_kwDOcache42",
      databaseId: 42,
      number: 42,
      title: "Cached PR",
      state: "OPEN",
      isDraft: false,
      url: "https://github.com/octocat/Hello-World/pull/42",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-02T00:00:00Z",
      author: { login: "octocat", avatarUrl: "https://github.com/images/error/octocat_happy.gif" },
      repository: { nameWithOwner: "octocat/Hello-World" },
      headRefName: "feature-branch",
      baseRefName: "main",
      reviewDecision: "APPROVED",
      labels: { nodes: [] },
      ...overrides,
    };
  }

  function makeHeavyPR(overrides: Record<string, unknown> = {}) {
    return {
      id: "PR_kwDOcache42",
      databaseId: 42,
      headRefOid: "abc123def456",
      headRepository: { owner: { login: "octocat" }, nameWithOwner: "octocat/Hello-World" },
      mergeStateStatus: "CLEAN",
      assignees: { nodes: [{ login: "octocat" }] },
      reviewRequests: { nodes: [] },
      latestReviews: { totalCount: 1, nodes: [{ author: { login: "reviewer1" } }] },
      additions: 50,
      deletions: 10,
      changedFiles: 3,
      comments: { totalCount: 2 },
      reviewThreads: { totalCount: 1 },
      statusCheckRollup: { state: "SUCCESS" },
      autoMergeRequest: null,
      viewerLatestReview: { state: "APPROVED" },
      viewerLatestReviewRequest: null,
      ...overrides,
    };
  }

  it("excludes archived repos from every repo-scoped search query (involves, review-requested, monitored)", async () => {
    const searchQueries: string[] = [];
    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async (_query: string, variables?: unknown) => {
        const vars = (variables ?? {}) as Record<string, unknown>;
        if ("ids" in vars) return { nodes: [makeHeavyPR()] };
        for (const key of ["issueQ", "prInvQ", "prRevQ", "prQ"]) {
          if (typeof vars[key] === "string") searchQueries.push(vars[key]);
        }
        return {
          issues: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prInvolves: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [makeLightPR()] },
          prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prs: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        };
      }
    );
    const monitoredRepo: RepoRef = { owner: "org", name: "monitored", fullName: "org/monitored" };

    await fetchIssuesAndPullRequests(octokit as never, [testRepo, monitoredRepo], "octocat", {
      monitoredRepos: [monitoredRepo],
    });

    // 3 light-search queries (issues, involves, review-requested) + 2 unfiltered (issues, prs)
    expect(searchQueries.length).toBeGreaterThanOrEqual(5);
    expect(searchQueries.some((q) => q.includes("review-requested:octocat"))).toBe(true);
    expect(searchQueries.some((q) => q.includes("repo:org/monitored") && !q.includes("involves:"))).toBe(true);
    for (const q of searchQueries) {
      expect(q).toContain("archived:false");
    }
  });

  it("serves settled PRs (including settled fork PRs) from cache within the TTL without re-running HEAVY_PR_BACKFILL_QUERY or fork check", async () => {
    let heavyCalls = 0;
    let forkCalls = 0;

    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async (query: string, variables?: unknown) => {
        const vars = (variables ?? {}) as Record<string, unknown>;
        if ("ids" in vars) {
          heavyCalls++;
          // Simulate a fork PR where main repo statusCheckRollup is null so fork0 fallback resolves it
          return {
            nodes: [
              makeHeavyPR({
                headRepository: { owner: { login: "fork-owner" }, nameWithOwner: "fork-owner/Hello-World" },
                statusCheckRollup: null,
              }),
            ],
          };
        }
        if (query.includes("fork0:")) {
          forkCalls++;
          return {
            fork0: {
              object: {
                statusCheckRollup: { state: "SUCCESS" },
              },
            },
          };
        }
        return {
          issues: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prInvolves: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [makeLightPR()] },
          prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        };
      }
    );

    // Poll 1: populates cache after runForkPRFallback resolves checkStatus = "success"
    const res1 = await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
    expect(heavyCalls).toBe(1);
    expect(forkCalls).toBe(1);
    expect(res1.pullRequests[0].enriched).toBe(true);
    expect(res1.pullRequests[0].checkStatus).toBe("success");

    // Poll 2 within the TTL with identical updatedAt and userLogin: hits cache, skips heavy backfill and fork check
    const res2 = await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
    expect(heavyCalls).toBe(1);
    expect(forkCalls).toBe(1);
    expect(res2.pullRequests[0].enriched).toBe(true);
    expect(res2.pullRequests[0].checkStatus).toBe("success");
    expect(res2.pullRequests[0].additions).toBe(50);
  });

  it("re-fetches when updatedAt changes, TTL expires, force=true is passed, repo/node is invalidated, or resetPREnrichmentCache is called", async () => {
    vi.useFakeTimers();
    let currentUpdatedAt = "2024-01-02T00:00:00Z";
    let heavyCalls = 0;

    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async (_query: string, variables?: unknown) => {
        const vars = (variables ?? {}) as Record<string, unknown>;
        if ("ids" in vars) {
          heavyCalls++;
          return { nodes: [makeHeavyPR()] };
        }
        return {
          issues: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prInvolves: {
            issueCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [makeLightPR({ updatedAt: currentUpdatedAt })],
          },
          prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        };
      }
    );

    try {
      // Seed cache
      await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
      expect(heavyCalls).toBe(1);

      // Cache hit
      await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
      expect(heavyCalls).toBe(1);

      // 1. force = true bypasses cache
      await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat", { force: true });
      expect(heavyCalls).toBe(2);

      // 2. invalidatePREnrichmentCacheForRepos evicts repo entries
      invalidatePREnrichmentCacheForRepos(["OCTOCAT/Hello-World"]);
      await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
      expect(heavyCalls).toBe(3);

      // 3. evictPREnrichmentCacheNode evicts specific node
      evictPREnrichmentCacheNode("PR_kwDOcache42");
      await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
      expect(heavyCalls).toBe(4);

      // 4. resetPREnrichmentCache clears all entries
      resetPREnrichmentCache();
      await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
      expect(heavyCalls).toBe(5);

      // 5. TTL expiration (default 3-minute floor) triggers re-fetch
      vi.advanceTimersByTime(MIN_ENRICHMENT_CACHE_TTL_MS + 1);
      await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
      expect(heavyCalls).toBe(6);

      // 6. updatedAt change triggers re-fetch
      currentUpdatedAt = "2024-01-03T00:00:00Z";
      await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
      expect(heavyCalls).toBe(7);

      // 7. Different userLogin does not reuse previous user's cache entry
      await fetchIssuesAndPullRequests(octokit as never, [testRepo], "other-user");
      expect(heavyCalls).toBe(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never caches PRs with non-terminal checkStatus ('running', 'waiting', 'pending') or checkStatusStale === true", async () => {
    let heavyCalls = 0;
    let mode: "running" | "waiting" | "pending" | "stale" = "running";

    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async (query: string, variables?: unknown) => {
        const vars = (variables ?? {}) as Record<string, unknown>;
        if ("ids" in vars) {
          if (mode === "running") {
            heavyCalls++;
            return {
              nodes: [
                makeHeavyPR({
                  statusCheckRollup: {
                    state: "PENDING",
                    contexts: {
                      checkRunCountsByState: [{ state: "IN_PROGRESS", count: 1 }],
                    },
                  },
                }),
              ],
            };
          }
          if (mode === "waiting") {
            heavyCalls++;
            return {
              nodes: [
                makeHeavyPR({
                  statusCheckRollup: {
                    state: "PENDING",
                    contexts: {
                      checkRunCountsByState: [{ state: "WAITING", count: 1 }],
                    },
                  },
                }),
              ],
            };
          }
          if (mode === "pending") {
            heavyCalls++;
            return {
              nodes: [
                makeHeavyPR({
                  statusCheckRollup: { state: "PENDING" },
                }),
              ],
            };
          }
          // mode === "stale": fail heavy query, succeed light fallback
          if (query.includes("statusCheckRollup")) {
            heavyCalls++;
            throw new TypeError("Failed to fetch");
          }
          return {
            nodes: [
              {
                id: "PR_kwDOcache42",
                databaseId: 42,
                headRefOid: "abc123def456",
                headRepository: null,
                assignees: { nodes: [] },
                reviewRequests: { nodes: [] },
                latestReviews: { totalCount: 0, nodes: [] },
                additions: 10,
                deletions: 2,
                changedFiles: 1,
                comments: { totalCount: 0 },
                reviewThreads: { totalCount: 0 },
                autoMergeRequest: null,
                viewerLatestReview: null,
                viewerLatestReviewRequest: null,
              },
            ],
          };
        }
        return {
          issues: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prInvolves: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [makeLightPR()] },
          prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        };
      }
    );

    // Running CI status must not be cached
    const runningRes1 = await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
    expect(runningRes1.pullRequests[0].checkStatus).toBe("running");
    expect(heavyCalls).toBe(1);

    await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
    expect(heavyCalls).toBe(2);

    // Waiting CI status must not be cached
    mode = "waiting";
    const waitingRes1 = await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
    expect(waitingRes1.pullRequests[0].checkStatus).toBe("waiting");
    expect(heavyCalls).toBe(3);

    await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
    expect(heavyCalls).toBe(4);

    // Pending CI status must not be cached
    mode = "pending";
    const pendingRes1 = await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
    expect(pendingRes1.pullRequests[0].checkStatus).toBe("pending");
    expect(heavyCalls).toBe(5);

    await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
    expect(heavyCalls).toBe(6);

    // Light fallback (checkStatusStale === true) must not be cached
    mode = "stale";
    const staleRes1 = await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
    expect(staleRes1.pullRequests[0].checkStatusStale).toBe(true);
    expect(heavyCalls).toBe(7);

    await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
    expect(heavyCalls).toBe(8);
  });

  it("marks fork PRs with checkStatusStale === true and skips caching when runForkPRFallback fails", async () => {
    let heavyCalls = 0;
    let forkCalls = 0;
    let failForkFallback = true;

    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async (query: string, variables?: unknown) => {
        const vars = (variables ?? {}) as Record<string, unknown>;
        if ("ids" in vars) {
          heavyCalls++;
          return {
            nodes: [
              makeHeavyPR({
                headRepository: { owner: { login: "contributor" }, nameWithOwner: "contributor/Hello-World" },
                statusCheckRollup: null,
              }),
            ],
          };
        }
        if (query.includes("fork0:")) {
          forkCalls++;
          if (failForkFallback) {
            throw new TypeError("Failed to fetch");
          }
          return {
            fork0: {
              object: {
                statusCheckRollup: { state: "SUCCESS" },
              },
            },
          };
        }
        return {
          issues: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prInvolves: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [makeLightPR()] },
          prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        };
      }
    );

    // Poll 1: fork fallback fails -> checkStatusStale is set to true and PR is not cached
    const res1 = await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
    expect(heavyCalls).toBe(1);
    expect(forkCalls).toBe(1);
    expect(res1.pullRequests[0].checkStatus).toBeNull();
    expect(res1.pullRequests[0].checkStatusStale).toBe(true);

    // Poll 2: because Poll 1 did not cache the failed fork check, it re-runs heavy backfill + fork fallback
    failForkFallback = false;
    const res2 = await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
    expect(heavyCalls).toBe(2);
    expect(forkCalls).toBe(2);
    expect(res2.pullRequests[0].checkStatus).toBe("success");
    expect(res2.pullRequests[0].checkStatusStale).toBeUndefined();
  });

  it("skips runForkPRFallback when a fork PR falls back to LIGHT_PR_BACKFILL_QUERY (checkStatusStale: true)", async () => {
    let forkCalls = 0;

    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async (query: string, variables?: unknown) => {
        const vars = (variables ?? {}) as Record<string, unknown>;
        if ("ids" in vars) {
          if (query.includes("statusCheckRollup")) {
            throw new TypeError("Failed to fetch");
          }
          // Light fallback succeeds for a fork PR
          return {
            nodes: [
              {
                id: "PR_kwDOcache42",
                databaseId: 42,
                headRefOid: "abc123def456",
                headRepository: { owner: { login: "contributor" }, nameWithOwner: "contributor/Hello-World" },
                assignees: { nodes: [] },
                reviewRequests: { nodes: [] },
                latestReviews: { totalCount: 0, nodes: [] },
                additions: 10,
                deletions: 2,
                changedFiles: 1,
                comments: { totalCount: 0 },
                reviewThreads: { totalCount: 0 },
                autoMergeRequest: null,
                viewerLatestReview: null,
                viewerLatestReviewRequest: null,
              },
            ],
          };
        }
        if (query.includes("fork0:")) {
          forkCalls++;
          return {
            fork0: {
              object: {
                statusCheckRollup: { state: "SUCCESS" },
              },
            },
          };
        }
        return {
          issues: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prInvolves: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [makeLightPR()] },
          prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        };
      }
    );

    const res = await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
    expect(forkCalls).toBe(0);
    expect(res.pullRequests[0].checkStatus).toBeNull();
    expect(res.pullRequests[0].checkStatusStale).toBe(true);
  });

  it("serves delta-backfill (monitoredRepos) PRs from cache and evicts closed PRs on clean polls without evicting unpolled repos", async () => {
    const monitoredRepo = { owner: "octocat", name: "Monitored", fullName: "octocat/Monitored" };
    let includeMainPr = true;
    let failSearch = false;
    let heavyCalls = 0;

    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async (query: string, variables?: unknown) => {
        const vars = (variables ?? {}) as Record<string, unknown>;
        if ("ids" in vars) {
          heavyCalls++;
          const ids = vars.ids as string[];
          return {
            nodes: ids.map((id) =>
              makeHeavyPR({
                id,
                databaseId: id === "PR_kwDOcache42" ? 42 : 99,
              })
            ),
          };
        }
        if (query.includes("prs: search(")) {
          return {
            issues: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            prs: {
              issueCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                makeLightPR({
                  id: "PR_kwDOmon99",
                  databaseId: 99,
                  number: 99,
                  repository: { nameWithOwner: "octocat/Monitored" },
                }),
              ],
            },
          };
        }
        if (failSearch) {
          throw Object.assign(new Error("Search 502"), { status: 502 });
        }
        return {
          issues: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prInvolves: {
            issueCount: includeMainPr ? 1 : 0,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: includeMainPr ? [makeLightPR()] : [],
          },
          prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        };
      }
    );

    // Poll 1: populates cache for both main PR (42 in octocat/Hello-World) and delta monitored PR (99 in octocat/Monitored)
    await fetchIssuesAndPullRequests(
      octokit as never,
      [testRepo, monitoredRepo],
      "octocat",
      { monitoredRepos: [monitoredRepo] }
    );
    expect(heavyCalls).toBe(2);

    // Poll 2: both main PR and monitored delta PR hit _prEnrichmentCache (0 new heavy calls)
    await fetchIssuesAndPullRequests(
      octokit as never,
      [testRepo, monitoredRepo],
      "octocat",
      { monitoredRepos: [monitoredRepo] }
    );
    expect(heavyCalls).toBe(2);

    // Poll 3: targeted poll of ONLY monitoredRepo does NOT evict octocat/Hello-World's cached PR
    await fetchIssuesAndPullRequests(
      octokit as never,
      [monitoredRepo],
      "octocat",
      { monitoredRepos: [monitoredRepo] }
    );
    expect(heavyCalls).toBe(2);

    // Poll 4: search error on octocat/Hello-World (allErrors.length > 0) does NOT evict its cached PR
    failSearch = true;
    await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
    failSearch = false;
    await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
    expect(heavyCalls).toBe(2);

    // Poll 5: clean poll where PR 42 is closed/absent evicts PR_kwDOcache42 from _prEnrichmentCache
    includeMainPr = false;
    await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
    includeMainPr = true;
    await fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");
    expect(heavyCalls).toBe(3);
  });

  it("derives the TTL from the refresh interval (interval + 60s, floored at 3 minutes) so settled PRs survive the next scheduled poll", async () => {
    vi.useFakeTimers();
    let heavyCalls = 0;
    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async (_query: string, variables?: unknown) => {
        const vars = (variables ?? {}) as Record<string, unknown>;
        if ("ids" in vars) {
          heavyCalls++;
          return { nodes: [makeHeavyPR()] };
        }
        return {
          issues: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prInvolves: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [makeLightPR()] },
          prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        };
      }
    );
    const poll = () => fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");

    try {
      // Default 300s interval → 360s TTL
      setPREnrichmentCacheRefreshInterval(300);
      await poll();
      expect(heavyCalls).toBe(1);

      // Next scheduled poll at the maximum jittered interval (300s + 30s) hits the cache
      vi.advanceTimersByTime(330_000);
      await poll();
      expect(heavyCalls).toBe(1);

      // At interval + 60s the entry has expired
      vi.advanceTimersByTime(30_000);
      await poll();
      expect(heavyCalls).toBe(2);

      // Short intervals and auto-refresh off (0) fall back to the 3-minute floor
      for (const intervalSec of [60, 0]) {
        setPREnrichmentCacheRefreshInterval(intervalSec);
        resetPREnrichmentCache();
        const before = heavyCalls;
        await poll();
        expect(heavyCalls).toBe(before + 1);
        vi.advanceTimersByTime(MIN_ENRICHMENT_CACHE_TTL_MS - 1);
        await poll();
        expect(heavyCalls).toBe(before + 1);
        vi.advanceTimersByTime(1);
        await poll();
        expect(heavyCalls).toBe(before + 2);
      }
    } finally {
      setPREnrichmentCacheRefreshInterval(0);
      vi.useRealTimers();
    }
  });

  it("skips cache writes when the cache generation changes or the client is swapped while the backfill is in flight", async () => {
    const githubModule = await import("../../src/app/services/github");
    let heavyCalls = 0;
    let holdHeavy = false;
    const releaseHeavy: Array<() => void> = [];
    const octokit = makeOctokit(
      async () => ({ data: {} }),
      async (_query: string, variables?: unknown) => {
        const vars = (variables ?? {}) as Record<string, unknown>;
        if ("ids" in vars) {
          heavyCalls++;
          if (holdHeavy) {
            await new Promise<void>((resolve) => releaseHeavy.push(resolve));
          }
          return { nodes: [makeHeavyPR()] };
        }
        return {
          issues: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          prInvolves: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [makeLightPR()] },
          prReviewReq: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        };
      }
    );
    const poll = () => fetchIssuesAndPullRequests(octokit as never, [testRepo], "octocat");

    // Starts a poll, waits until its heavy backfill is pending, runs `interrupt`, then resolves the backfill
    const pollWithInterrupt = async (interrupt: () => void) => {
      holdHeavy = true;
      const callsBefore = heavyCalls;
      const pending = poll();
      await vi.waitFor(() => expect(heavyCalls).toBe(callsBefore + 1));
      interrupt();
      holdHeavy = false;
      releaseHeavy.shift()!();
      const res = await pending;
      expect(res.pullRequests[0].enriched).toBe(true);
    };

    // 1. evictPREnrichmentCacheNode while the backfill is in flight: the result is not cached
    await pollWithInterrupt(() => evictPREnrichmentCacheNode("PR_kwDOcache42"));
    await poll();
    expect(heavyCalls).toBe(2);
    // Control: an uninterrupted poll's result is cached
    await poll();
    expect(heavyCalls).toBe(2);

    // 2. invalidatePREnrichmentCacheForRepos while the backfill is in flight
    resetPREnrichmentCache();
    await pollWithInterrupt(() => invalidatePREnrichmentCacheForRepos(["octocat/Hello-World"]));
    await poll();
    expect(heavyCalls).toBe(4);

    // 3. Client swapped (logout / re-auth) while the backfill is in flight
    resetPREnrichmentCache();
    const getClientSpy = vi.spyOn(githubModule, "getClient");
    try {
      await pollWithInterrupt(() => {
        getClientSpy.mockReturnValue(makeOctokit(async () => ({ data: {} })) as never);
      });
    } finally {
      getClientSpy.mockRestore();
    }
    await poll();
    expect(heavyCalls).toBe(6);

    // 4. getClient() returning the polling octokit permits the write
    resetPREnrichmentCache();
    const sameClientSpy = vi.spyOn(githubModule, "getClient").mockReturnValue(octokit as never);
    try {
      await poll();
      await poll();
    } finally {
      sameClientSpy.mockRestore();
    }
    expect(heavyCalls).toBe(7);
  });
});

describe("revision helpers", () => {
  it("isSameRevision compares headSha when both known, else updatedAt", () => {
    expect(isSameRevision({ headSha: "a", updatedAt: "t1" }, { headSha: "a", updatedAt: "t2" })).toBe(true);
    expect(isSameRevision({ headSha: "a", updatedAt: "t1" }, { headSha: "b", updatedAt: "t1" })).toBe(false);
    expect(isSameRevision({ headSha: "", updatedAt: "t1" }, { headSha: "b", updatedAt: "t1" })).toBe(true);
    expect(isSameRevision({ headSha: "", updatedAt: "t1" }, { headSha: "b", updatedAt: "t2" })).toBe(false);
  });

  it("hasRevisionChanged flags an updatedAt change or differing known headShas", () => {
    expect(hasRevisionChanged({ headSha: "a", updatedAt: "t1" }, { headSha: "a", updatedAt: "t2" })).toBe(true);
    expect(hasRevisionChanged({ headSha: "a", updatedAt: "t1" }, { headSha: "b", updatedAt: "t1" })).toBe(true);
    expect(hasRevisionChanged({ headSha: "", updatedAt: "t1" }, { headSha: "b", updatedAt: "t1" })).toBe(false);
  });

  it("markCheckStatusStale clears headSha/checkStatus and sets the stale flag in place", () => {
    const pr = makePullRequest({ headSha: "abc", checkStatus: "success", checkStatusStale: false });
    expect(markCheckStatusStale(pr)).toBe(pr);
    expect(pr).toMatchObject({ headSha: "", checkStatus: null, checkStatusStale: true });
  });
});

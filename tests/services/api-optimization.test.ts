import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchIssues,
  fetchPullRequests,
  fetchIssuesAndPullRequests,
  fetchWorkflowRuns,
  type RepoRef,
} from "../../src/app/services/api";
import { clearCache } from "../../src/app/stores/cache";

vi.mock("../../src/app/lib/errors", () => ({
  pushNotification: vi.fn(),
  pushError: vi.fn(),
  getErrors: vi.fn().mockReturnValue([]),
  dismissError: vi.fn(),
  getNotifications: vi.fn().mockReturnValue([]),
  getUnreadCount: vi.fn().mockReturnValue(0),
  markAllAsRead: vi.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const graphqlIssueNode = {
  databaseId: 1347,
  number: 1347,
  title: "Found a bug",
  state: "open",
  url: "https://github.com/octocat/Hello-World/issues/1347",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-02T00:00:00Z",
  author: { login: "octocat", avatarUrl: "https://github.com/images/error/octocat_happy.gif" },
  labels: { nodes: [{ name: "bug", color: "d73a4a" }] },
  assignees: { nodes: [{ login: "octocat" }] },
  repository: { nameWithOwner: "octocat/Hello-World" },
  comments: { totalCount: 3 },
};

const graphqlPRNode = {
  databaseId: 42,
  number: 42,
  title: "Add feature",
  state: "open",
  isDraft: false,
  url: "https://github.com/octocat/Hello-World/pull/42",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-02T00:00:00Z",
  author: { login: "octocat", avatarUrl: "https://github.com/images/error/octocat_happy.gif" },
  headRefOid: "abc123",
  headRefName: "feature-branch",
  baseRefName: "main",
  headRepository: { owner: { login: "octocat" }, nameWithOwner: "octocat/Hello-World" },
  repository: { nameWithOwner: "octocat/Hello-World" },
  mergeStateStatus: "CLEAN",
  assignees: { nodes: [{ login: "octocat" }] },
  reviewRequests: { nodes: [{ requestedReviewer: { login: "reviewer2" } }] },
  labels: { nodes: [{ name: "feature", color: "a2eeef" }] },
  additions: 100,
  deletions: 20,
  changedFiles: 5,
  comments: { totalCount: 3 },
  reviewThreads: { totalCount: 2 },
  reviewDecision: "APPROVED",
  latestReviews: { totalCount: 1, nodes: [{ author: { login: "reviewer1" } }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
};

const rateLimit = { remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() };

function makeSearchResponse<T>(nodes: T[], hasNextPage = false) {
  return {
    issueCount: nodes.length,
    pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor1" : null },
    nodes,
  };
}

function makeCombinedResponse(
  issueNodes = [graphqlIssueNode],
  prNodes = [graphqlPRNode],
  issueHasNext = false,
  prInvHasNext = false,
  prRevHasNext = false,
) {
  return {
    issues: makeSearchResponse(issueNodes, issueHasNext),
    prInvolves: makeSearchResponse(prNodes, prInvHasNext),
    prReviewReq: makeSearchResponse([], prRevHasNext),
    rateLimit,
  };
}

function makeRepos(count: number): RepoRef[] {
  return Array.from({ length: count }, (_, i) => ({
    owner: "org",
    name: `repo-${i}`,
    fullName: `org/repo-${i}`,
  }));
}

type OctokitLike = ReturnType<typeof import("../../src/app/services/github").getClient>;

function makeOctokit(graphqlImpl: (query: string, variables?: unknown) => Promise<unknown>) {
  return {
    request: vi.fn(async () => ({ data: [], headers: {} })),
    graphql: vi.fn(graphqlImpl),
    paginate: { iterator: vi.fn() },
  };
}

beforeEach(async () => {
  await clearCache();
  vi.resetAllMocks();
});

// ── Call count verification: combined vs separate ─────────────────────────────

describe("API call count: combined vs separate", () => {

  describe("with 1-50 repos (single chunk)", () => {
    const repos = makeRepos(30);

    it("separate fetchIssues + fetchPullRequests makes 3 GraphQL calls", async () => {
      const octokit = makeOctokit(async () => ({
        search: makeSearchResponse([graphqlIssueNode]),
        rateLimit,
      }));

      await fetchIssues(octokit as unknown as OctokitLike, repos, "testuser");
      const issuesCalls = octokit.graphql.mock.calls.length;

      octokit.graphql.mockClear();
      await fetchPullRequests(octokit as unknown as OctokitLike, repos, "testuser");
      const prCalls = octokit.graphql.mock.calls.length;

      // Issues: 1 call, PRs: 2 calls (involves + review-requested) = 3 total
      expect(issuesCalls).toBe(1);
      expect(prCalls).toBe(2);
      expect(issuesCalls + prCalls).toBe(3);
    });

    it("combined fetchIssuesAndPullRequests makes 1 GraphQL call", async () => {
      const octokit = makeOctokit(async () => makeCombinedResponse());

      await fetchIssuesAndPullRequests(octokit as unknown as OctokitLike, repos, "testuser");

      // Combined: 1 call with 3 aliases
      expect(octokit.graphql).toHaveBeenCalledTimes(1);
    });

    it("combined returns same data as separate calls", async () => {
      // Separate calls
      const separateOctokit = makeOctokit(async (_query, variables) => {
        const q = (variables as Record<string, unknown>).q as string;
        if (q.includes("is:issue")) {
          return { search: makeSearchResponse([graphqlIssueNode]), rateLimit };
        }
        return { search: makeSearchResponse([graphqlPRNode]), rateLimit };
      });

      const issueResult = await fetchIssues(separateOctokit as unknown as OctokitLike, repos, "testuser");
      const prResult = await fetchPullRequests(separateOctokit as unknown as OctokitLike, repos, "testuser");

      // Combined call
      const combinedOctokit = makeOctokit(async () => makeCombinedResponse());
      const combinedResult = await fetchIssuesAndPullRequests(combinedOctokit as unknown as OctokitLike, repos, "testuser");

      // Same data shape and content
      expect(combinedResult.issues.length).toBe(issueResult.issues.length);
      expect(combinedResult.pullRequests.length).toBe(prResult.pullRequests.length);
      expect(combinedResult.issues[0].id).toBe(issueResult.issues[0].id);
      expect(combinedResult.pullRequests[0].id).toBe(prResult.pullRequests[0].id);
    });
  });

  describe("with 51-100 repos (two chunks)", () => {
    const repos = makeRepos(80);

    it("separate fetchIssues + fetchPullRequests makes 6 GraphQL calls", async () => {
      const octokit = makeOctokit(async () => ({
        search: makeSearchResponse([{ ...graphqlIssueNode, databaseId: Math.random() * 100000 | 0 }]),
        rateLimit,
      }));

      await fetchIssues(octokit as unknown as OctokitLike, repos, "testuser");
      const issuesCalls = octokit.graphql.mock.calls.length;

      octokit.graphql.mockClear();
      await fetchPullRequests(octokit as unknown as OctokitLike, repos, "testuser");
      const prCalls = octokit.graphql.mock.calls.length;

      // Issues: 2 chunks × 1 call = 2, PRs: 2 chunks × 2 query types = 4
      expect(issuesCalls).toBe(2);
      expect(prCalls).toBe(4);
      expect(issuesCalls + prCalls).toBe(6);
    });

    it("combined fetchIssuesAndPullRequests makes 2 GraphQL calls", async () => {
      const octokit = makeOctokit(async () => makeCombinedResponse(
        [{ ...graphqlIssueNode, databaseId: Math.random() * 100000 | 0 }],
        [{ ...graphqlPRNode, databaseId: Math.random() * 100000 | 0 }],
      ));

      await fetchIssuesAndPullRequests(octokit as unknown as OctokitLike, repos, "testuser");

      // Combined: 2 chunks × 1 call each = 2 (vs 6 separate)
      expect(octokit.graphql).toHaveBeenCalledTimes(2);
    });
  });

  describe("with 101-150 repos (three chunks)", () => {
    const repos = makeRepos(120);

    it("separate makes 9 calls, combined makes 3", async () => {
      let callId = 0;
      const separateOctokit = makeOctokit(async () => ({
        search: makeSearchResponse([{ ...graphqlIssueNode, databaseId: ++callId }]),
        rateLimit,
      }));

      await fetchIssues(separateOctokit as unknown as OctokitLike, repos, "testuser");
      const issuesCalls = separateOctokit.graphql.mock.calls.length;
      separateOctokit.graphql.mockClear();
      await fetchPullRequests(separateOctokit as unknown as OctokitLike, repos, "testuser");
      const prCalls = separateOctokit.graphql.mock.calls.length;

      // Issues: 3 chunks, PRs: 3 chunks × 2 = 6
      expect(issuesCalls).toBe(3);
      expect(prCalls).toBe(6);

      callId = 0;
      const combinedOctokit = makeOctokit(async () => makeCombinedResponse(
        [{ ...graphqlIssueNode, databaseId: ++callId }],
        [{ ...graphqlPRNode, databaseId: callId + 10000 }],
      ));

      await fetchIssuesAndPullRequests(combinedOctokit as unknown as OctokitLike, repos, "testuser");

      // Combined: 3 chunks × 1 call each = 3 (vs 9 separate)
      expect(combinedOctokit.graphql).toHaveBeenCalledTimes(3);
    });
  });
});

// ── Pagination fallback verification ──────────────────────────────────────────

describe("combined query pagination fallback", () => {
  const repos = makeRepos(30);

  it("fires follow-up queries only for aliases that need pagination", async () => {
    let callCount = 0;
    const octokit = makeOctokit(async (_query, variables) => {
      callCount++;
      const vars = variables as Record<string, unknown>;

      if (callCount === 1) {
        // First call: combined query. Issues need pagination, PRs don't.
        return {
          issues: makeSearchResponse([graphqlIssueNode], true), // hasNextPage
          prInvolves: makeSearchResponse([graphqlPRNode], false),
          prReviewReq: makeSearchResponse([], false),
          rateLimit,
        };
      }

      // Follow-up: should be an individual issue search query (has cursor)
      expect(vars.cursor).toBe("cursor1");
      expect(vars.q).toContain("is:issue");
      return {
        search: makeSearchResponse([{ ...graphqlIssueNode, databaseId: 9999 }], false),
        rateLimit,
      };
    });

    const result = await fetchIssuesAndPullRequests(octokit as unknown as OctokitLike, repos, "testuser");

    // 1 combined + 1 pagination follow-up = 2 total
    expect(callCount).toBe(2);
    expect(result.issues.length).toBe(2); // page 1 + page 2
    expect(result.pullRequests.length).toBe(1);
  });

  it("does not fire follow-up when no alias needs pagination", async () => {
    const octokit = makeOctokit(async () => makeCombinedResponse());

    await fetchIssuesAndPullRequests(octokit as unknown as OctokitLike, repos, "testuser");

    expect(octokit.graphql).toHaveBeenCalledTimes(1);
  });
});

// ── Combined query sends correct query strings ────────────────────────────────

describe("combined query structure", () => {
  const repos = makeRepos(5);

  it("sends all three search strings in one call with correct qualifiers", async () => {
    const octokit = makeOctokit(async () => makeCombinedResponse());

    await fetchIssuesAndPullRequests(octokit as unknown as OctokitLike, repos, "testuser");

    expect(octokit.graphql).toHaveBeenCalledTimes(1);
    const [, variables] = octokit.graphql.mock.calls[0] as [string, Record<string, unknown>];

    // Issue query string
    expect(variables.issueQ).toContain("is:issue");
    expect(variables.issueQ).toContain("is:open");
    expect(variables.issueQ).toContain("involves:testuser");
    expect(variables.issueQ).toContain("repo:org/repo-0");

    // PR involves query string
    expect(variables.prInvQ).toContain("is:pr");
    expect(variables.prInvQ).toContain("involves:testuser");

    // PR review-requested query string
    expect(variables.prRevQ).toContain("is:pr");
    expect(variables.prRevQ).toContain("review-requested:testuser");
  });

  it("uses GraphQL aliases (issues, prInvolves, prReviewReq) in the query", async () => {
    const octokit = makeOctokit(async () => makeCombinedResponse());

    await fetchIssuesAndPullRequests(octokit as unknown as OctokitLike, repos, "testuser");

    const [query] = octokit.graphql.mock.calls[0] as [string];
    expect(query).toContain("issues: search(");
    expect(query).toContain("prInvolves: search(");
    expect(query).toContain("prReviewReq: search(");
    expect(query).toContain("PRSearchFields");
  });
});

// ── Workflow run concurrency verification ─────────────────────────────────────

describe("workflow run concurrency", () => {
  it("starts all repo fetches concurrently up to concurrency limit", async () => {
    const repos = makeRepos(25);
    const concurrentPeak = { current: 0, max: 0 };

    const octokit = {
      request: vi.fn(async () => {
        concurrentPeak.current++;
        concurrentPeak.max = Math.max(concurrentPeak.max, concurrentPeak.current);
        // Simulate network delay
        await new Promise((r) => setTimeout(r, 10));
        concurrentPeak.current--;
        return {
          data: { workflow_runs: [], total_count: 0 },
          headers: { etag: "etag" },
        };
      }),
      paginate: { iterator: vi.fn() },
    };

    await fetchWorkflowRuns(
      octokit as unknown as OctokitLike,
      repos,
      5,
      3
    );

    // Should reach concurrency > 10 (old limit was 10, new is 20)
    // With 25 repos, all 25 should start within the 20-worker pool
    expect(concurrentPeak.max).toBeGreaterThan(10);
    expect(concurrentPeak.max).toBeLessThanOrEqual(20);
    // All repos should be fetched
    expect(octokit.request).toHaveBeenCalledTimes(25);
  });

  it("processes repos faster with pooled concurrency than sequential chunks", async () => {
    const repos = makeRepos(30);
    const DELAY_MS = 5;

    const makeTimedOctokit = () => ({
      request: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, DELAY_MS));
        return {
          data: { workflow_runs: [], total_count: 0 },
          headers: { etag: "etag" },
        };
      }),
      paginate: { iterator: vi.fn() },
    });

    // Measure pooled approach (current implementation)
    const pooledOctokit = makeTimedOctokit();
    const pooledStart = performance.now();
    await fetchWorkflowRuns(pooledOctokit as unknown as OctokitLike, repos, 5, 3);
    const pooledDuration = performance.now() - pooledStart;

    // Sequential simulation: 3 batches of 10, each batch waits for all to finish
    const sequentialStart = performance.now();
    for (let i = 0; i < 3; i++) {
      await Promise.all(
        repos.slice(i * 10, (i + 1) * 10).map(() => new Promise((r) => setTimeout(r, DELAY_MS)))
      );
    }
    const sequentialDuration = performance.now() - sequentialStart;

    // Pooled should be faster because it starts all 30 within 20-worker pool
    // instead of waiting for 3 sequential batches of 10
    expect(pooledDuration).toBeLessThan(sequentialDuration);
  });
});

// ── Scaling: call count grows linearly with chunks ────────────────────────────

describe("scaling behavior", () => {
  const repoCountsAndExpected = [
    { repos: 10, separateCalls: 3, combinedCalls: 1 },
    { repos: 50, separateCalls: 3, combinedCalls: 1 },
    { repos: 51, separateCalls: 6, combinedCalls: 2 },
    { repos: 100, separateCalls: 6, combinedCalls: 2 },
    { repos: 150, separateCalls: 9, combinedCalls: 3 },
  ];

  for (const { repos: repoCount, separateCalls, combinedCalls } of repoCountsAndExpected) {
    it(`${repoCount} repos: separate=${separateCalls} calls, combined=${combinedCalls} calls (${Math.round((1 - combinedCalls / separateCalls) * 100)}% reduction)`, async () => {
      const repos = makeRepos(repoCount);
      let nodeId = 0;

      // Count separate calls
      const sepOctokit = makeOctokit(async () => ({
        search: makeSearchResponse([{ ...graphqlIssueNode, databaseId: ++nodeId }]),
        rateLimit,
      }));
      await fetchIssues(sepOctokit as unknown as OctokitLike, repos, "testuser");
      const issueCalls = sepOctokit.graphql.mock.calls.length;
      sepOctokit.graphql.mockClear();
      nodeId = 0;
      await fetchPullRequests(sepOctokit as unknown as OctokitLike, repos, "testuser");
      const prCalls = sepOctokit.graphql.mock.calls.length;
      expect(issueCalls + prCalls).toBe(separateCalls);

      // Count combined calls
      nodeId = 0;
      const combOctokit = makeOctokit(async () => makeCombinedResponse(
        [{ ...graphqlIssueNode, databaseId: ++nodeId }],
        [{ ...graphqlPRNode, databaseId: nodeId + 50000 }],
      ));
      await fetchIssuesAndPullRequests(combOctokit as unknown as OctokitLike, repos, "testuser");
      expect(combOctokit.graphql).toHaveBeenCalledTimes(combinedCalls);
    });
  }
});

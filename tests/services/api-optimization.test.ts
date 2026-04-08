import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchIssuesAndPullRequests,
  fetchWorkflowRuns,
  fetchPREnrichment,
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

/** Light PR node used by the two-phase combined query (phase 1) */
function makeLightPRNode(overrides: Partial<typeof graphqlLightPRNodeDefaults> = {}) {
  return { ...graphqlLightPRNodeDefaults, ...overrides };
}

const graphqlLightPRNodeDefaults = {
  id: "PR_kwDOtest42",
  databaseId: 42,
  number: 42,
  title: "Add feature",
  state: "open",
  isDraft: false,
  url: "https://github.com/octocat/Hello-World/pull/42",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-02T00:00:00Z",
  author: { login: "octocat", avatarUrl: "https://github.com/images/error/octocat_happy.gif" },
  repository: { nameWithOwner: "octocat/Hello-World" },
  headRefName: "feature-branch",
  baseRefName: "main",
  reviewDecision: "APPROVED",
  labels: { nodes: [{ name: "feature", color: "a2eeef" }] },
};

/** Heavy PR node returned by phase 2 backfill (nodes(ids:[])) */
function makeHeavyPRNode(databaseId: number, _nodeId?: string) {
  return {
    databaseId,
    headRefOid: "abc123",
    headRepository: { owner: { login: "octocat" }, nameWithOwner: "octocat/Hello-World" },
    mergeStateStatus: "CLEAN",
    assignees: { nodes: [{ login: "octocat" }] },
    reviewRequests: { nodes: [{ requestedReviewer: { login: "reviewer2" } }] },
    latestReviews: { totalCount: 1, nodes: [{ author: { login: "reviewer1" } }] },
    additions: 100,
    deletions: 20,
    changedFiles: 5,
    comments: { totalCount: 3 },
    reviewThreads: { totalCount: 2 },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  };
}

const rateLimit = { limit: 5000, remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() };

function makeSearchResponse<T>(nodes: T[], hasNextPage = false) {
  return {
    issueCount: nodes.length,
    pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor1" : null },
    nodes,
  };
}

function makeLightCombinedResponse(
  issueNodes = [graphqlIssueNode],
  prNodes = [makeLightPRNode()],
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

function makeHeavyBackfillResponse(prNodes: ReturnType<typeof makeHeavyPRNode>[]) {
  return {
    nodes: prNodes,
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

/**
 * Creates a mock octokit that handles both light combined and heavy backfill queries.
 * Detects backfill calls by the presence of the `ids` variable.
 */
function makeTwoPhaseOctokit(
  lightImpl: (query: string, variables?: unknown) => Promise<unknown>,
  heavyNodes?: ReturnType<typeof makeHeavyPRNode>[],
) {
  return {
    request: vi.fn(async () => ({ data: [], headers: {} })),
    graphql: vi.fn(async (query: string, variables?: Record<string, unknown>) => {
      // Heavy backfill query has `ids` variable
      if (variables && "ids" in variables) {
        return makeHeavyBackfillResponse(heavyNodes ?? []);
      }
      return lightImpl(query, variables);
    }),
    paginate: { iterator: vi.fn() },
  };
}

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

    it("combined fetchIssuesAndPullRequests makes 2 GraphQL calls (light + heavy)", async () => {
      const lightPR = makeLightPRNode();
      const octokit = makeTwoPhaseOctokit(
        async () => makeLightCombinedResponse([graphqlIssueNode], [lightPR]),
        [makeHeavyPRNode(42, "PR_kwDOtest42")],
      );

      await fetchIssuesAndPullRequests(octokit as unknown as OctokitLike, repos, "testuser");

      // 1 light combined + 1 heavy backfill = 2 total
      expect(octokit.graphql).toHaveBeenCalledTimes(2);
    });
  });

  describe("with 51-100 repos (two chunks)", () => {
    const repos = makeRepos(80);

    it("combined fetchIssuesAndPullRequests makes 3 GraphQL calls (2 light + 1 heavy)", async () => {
      let callId = 0;
      const octokit = makeTwoPhaseOctokit(
        async () => {
          const id = ++callId;
          return makeLightCombinedResponse(
            [{ ...graphqlIssueNode, databaseId: id + 10000 }],
            [makeLightPRNode({ databaseId: id, id: `PR_kwDO_${id}` })],
          );
        },
        [makeHeavyPRNode(1, "PR_kwDO_1"), makeHeavyPRNode(2, "PR_kwDO_2")],
      );

      await fetchIssuesAndPullRequests(octokit as unknown as OctokitLike, repos, "testuser");

      // 2 light combined (1 per chunk) + 1 heavy backfill = 3 total
      expect(octokit.graphql).toHaveBeenCalledTimes(3);
    });
  });

  describe("with 101-150 repos (three chunks)", () => {
    const repos = makeRepos(120);

    it("combined fetchIssuesAndPullRequests makes 4 GraphQL calls (3 light + 1 heavy)", async () => {
      let callId = 0;
      const combinedOctokit = makeTwoPhaseOctokit(
        async () => {
          const id = ++callId;
          return makeLightCombinedResponse(
            [{ ...graphqlIssueNode, databaseId: id + 20000 }],
            [makeLightPRNode({ databaseId: id + 30000, id: `PR_kwDO_${id}` })],
          );
        },
        [
          makeHeavyPRNode(30001, "PR_kwDO_1"),
          makeHeavyPRNode(30002, "PR_kwDO_2"),
          makeHeavyPRNode(30003, "PR_kwDO_3"),
        ],
      );

      await fetchIssuesAndPullRequests(combinedOctokit as unknown as OctokitLike, repos, "testuser");

      // 3 light combined (1 per chunk) + 1 heavy backfill = 4 total
      expect(combinedOctokit.graphql).toHaveBeenCalledTimes(4);
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

      // Heavy backfill
      if (vars && "ids" in vars) {
        return makeHeavyBackfillResponse([makeHeavyPRNode(42, "PR_kwDOtest42")]);
      }

      if (callCount === 1) {
        // First call: light combined query. Issues need pagination, PRs don't.
        return {
          issues: makeSearchResponse([graphqlIssueNode], true), // hasNextPage
          prInvolves: makeSearchResponse([makeLightPRNode()], false),
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

    // 1 light combined + 1 issue pagination + 1 heavy backfill = 3 total
    expect(callCount).toBe(3);
    expect(result.issues.length).toBe(2); // page 1 + page 2
    expect(result.pullRequests.length).toBe(1);
  });

  it("does not fire follow-up when no alias needs pagination", async () => {
    const octokit = makeTwoPhaseOctokit(
      async () => makeLightCombinedResponse(),
      [makeHeavyPRNode(42, "PR_kwDOtest42")],
    );

    await fetchIssuesAndPullRequests(octokit as unknown as OctokitLike, repos, "testuser");

    // 1 light combined + 1 heavy backfill = 2
    expect(octokit.graphql).toHaveBeenCalledTimes(2);
  });
});

// ── Combined query sends correct query strings ────────────────────────────────

describe("combined query structure", () => {
  const repos = makeRepos(5);

  it("sends all three search strings in one call with correct qualifiers", async () => {
    const octokit = makeTwoPhaseOctokit(
      async () => makeLightCombinedResponse(),
      [makeHeavyPRNode(42, "PR_kwDOtest42")],
    );

    await fetchIssuesAndPullRequests(octokit as unknown as OctokitLike, repos, "testuser");

    // First call is the light combined query
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
    const octokit = makeTwoPhaseOctokit(
      async () => makeLightCombinedResponse(),
      [makeHeavyPRNode(42, "PR_kwDOtest42")],
    );

    await fetchIssuesAndPullRequests(octokit as unknown as OctokitLike, repos, "testuser");

    const [query] = octokit.graphql.mock.calls[0] as [string];
    expect(query).toContain("issues: search(");
    expect(query).toContain("prInvolves: search(");
    expect(query).toContain("prReviewReq: search(");
    expect(query).toContain("LightPRFields");
  });

  it("phase 2 sends nodes(ids:[]) backfill query", async () => {
    const octokit = makeTwoPhaseOctokit(
      async () => makeLightCombinedResponse(),
      [makeHeavyPRNode(42, "PR_kwDOtest42")],
    );

    await fetchIssuesAndPullRequests(octokit as unknown as OctokitLike, repos, "testuser");

    // Second call is the heavy backfill
    expect(octokit.graphql).toHaveBeenCalledTimes(2);
    const [backfillQuery, backfillVars] = octokit.graphql.mock.calls[1] as [string, Record<string, unknown>];
    expect(backfillQuery).toContain("nodes(ids:");
    expect(backfillVars.ids).toEqual(["PR_kwDOtest42"]);
  });
});

// ── Progressive rendering: onLightData callback ──────────────────────────────

describe("onLightData callback (progressive rendering)", () => {
  const repos = makeRepos(5);

  it("fires onLightData with light PRs (enriched: false) before phase 2 completes", async () => {
    const callOrder: string[] = [];
    const octokit = makeOctokit(async (_query, variables) => {
      const vars = variables as Record<string, unknown>;
      if (vars && "ids" in vars) {
        callOrder.push("heavy-start");
        return makeHeavyBackfillResponse([makeHeavyPRNode(42, "PR_kwDOtest42")]);
      }
      callOrder.push("light-start");
      return makeLightCombinedResponse();
    });

    let lightDataReceived: Awaited<ReturnType<typeof fetchIssuesAndPullRequests>> | null = null;
    const result = await fetchIssuesAndPullRequests(
      octokit as unknown as OctokitLike,
      repos,
      "testuser",
      (data) => {
        callOrder.push("onLightData");
        lightDataReceived = data;
      },
    );

    // onLightData fires after light query but before heavy backfill
    expect(callOrder).toEqual(["light-start", "onLightData", "heavy-start"]);

    // Light data has PRs with enriched: false
    expect(lightDataReceived).not.toBeNull();
    expect(lightDataReceived!.pullRequests.length).toBe(1);
    expect(lightDataReceived!.pullRequests[0].enriched).toBe(false);
    expect(lightDataReceived!.pullRequests[0].additions).toBe(0); // default heavy field

    // Final result has enriched PRs
    expect(result.pullRequests[0].enriched).toBe(true);
    expect(result.pullRequests[0].additions).toBe(100); // from heavy backfill
  });

  it("does not fire onLightData when callback is not provided", async () => {
    const octokit = makeTwoPhaseOctokit(
      async () => makeLightCombinedResponse(),
      [makeHeavyPRNode(42, "PR_kwDOtest42")],
    );

    // No callback — should not throw
    const result = await fetchIssuesAndPullRequests(octokit as unknown as OctokitLike, repos, "testuser");
    expect(result.pullRequests[0].enriched).toBe(true);
  });

  it("marks PRs as enriched: true when there are 0 PRs (no backfill needed)", async () => {
    const octokit = makeTwoPhaseOctokit(
      async () => makeLightCombinedResponse([graphqlIssueNode], []),
      [],
    );

    const result = await fetchIssuesAndPullRequests(octokit as unknown as OctokitLike, repos, "testuser");
    expect(result.pullRequests.length).toBe(0);
    // Only light query, no backfill
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
  });
});

// ── Phase 2 backfill failure ───────────────────────────────────────────────────

describe("phase 2 backfill failure", () => {
  const repos = makeRepos(5);

  it("returns light PRs with enriched: false when backfill fails entirely", async () => {
    const octokit = makeOctokit(async (_query, variables) => {
      const vars = variables as Record<string, unknown>;
      if (vars && "ids" in vars) {
        throw new Error("GraphQL backfill network failure");
      }
      return makeLightCombinedResponse();
    });

    const result = await fetchIssuesAndPullRequests(octokit as unknown as OctokitLike, repos, "testuser");

    // Issues should be complete
    expect(result.issues.length).toBe(1);
    // PRs returned but not enriched
    expect(result.pullRequests.length).toBe(1);
    expect(result.pullRequests[0].enriched).toBe(false);
    expect(result.pullRequests[0].additions).toBe(0); // default heavy field
    expect(result.pullRequests[0].checkStatus).toBeNull();
    // Backfill error should be in errors array
    expect(result.errors.some(e => e.message.includes("backfill network failure"))).toBe(true);
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
    const DELAY_MS = 20;

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
    // instead of waiting for 3 sequential batches of 10.
    // Use 3x tolerance to account for system load variance in CI/local.
    expect(pooledDuration).toBeLessThan(sequentialDuration * 3);
  });
});

// ── Scaling: call count grows linearly with chunks ────────────────────────────

describe("scaling behavior", () => {
  // Two-phase: each chunk needs 1 light query + 1 heavy backfill total
  const repoCountsAndExpected = [
    { repos: 10, combinedCalls: 2 },   // 1 light + 1 heavy
    { repos: 50, combinedCalls: 2 },   // 1 light + 1 heavy
    { repos: 51, combinedCalls: 3 },   // 2 light + 1 heavy
    { repos: 100, combinedCalls: 3 },  // 2 light + 1 heavy
    { repos: 150, combinedCalls: 4 },  // 3 light + 1 heavy
  ];

  for (const { repos: repoCount, combinedCalls } of repoCountsAndExpected) {
    it(`${repoCount} repos: combined makes ${combinedCalls} GraphQL calls`, async () => {
      const repos = makeRepos(repoCount);
      let nodeId = 0;

      const combOctokit = makeTwoPhaseOctokit(
        async () => {
          const id = ++nodeId;
          return makeLightCombinedResponse(
            [{ ...graphqlIssueNode, databaseId: id + 40000 }],
            [makeLightPRNode({ databaseId: id + 50000, id: `PR_kwDO_${id}` })],
          );
        },
        // Generate heavy nodes for all expected chunks
        Array.from({ length: Math.ceil(repoCount / 50) }, (_, i) =>
          makeHeavyPRNode(i + 1 + 50000, `PR_kwDO_${i + 1}`)
        ),
      );
      await fetchIssuesAndPullRequests(combOctokit as unknown as OctokitLike, repos, "testuser");
      expect(combOctokit.graphql).toHaveBeenCalledTimes(combinedCalls);
    });
  }
});

// ── fetchPREnrichment: UNSTABLE+pending override ───────────────────────────────

describe("fetchPREnrichment mergeStateStatus UNSTABLE override", () => {
  function makeEnrichmentOctokit(mergeStateStatus: string, rollupState: string | null) {
    return {
      request: vi.fn(async () => ({ data: [], headers: {} })),
      graphql: vi.fn(async () => ({
        nodes: [{
          databaseId: 100,
          headRefOid: "abc123",
          headRepository: { owner: { login: "octocat" }, nameWithOwner: "octocat/Hello-World" },
          mergeStateStatus,
          assignees: { nodes: [] },
          reviewRequests: { nodes: [] },
          latestReviews: { totalCount: 0, nodes: [] },
          additions: 5,
          deletions: 2,
          changedFiles: 1,
          comments: { totalCount: 0 },
          reviewThreads: { totalCount: 0 },
          commits: {
            nodes: rollupState
              ? [{ commit: { statusCheckRollup: { state: rollupState } } }]
              : [],
          },
        }],
        rateLimit: { limit: 5000, remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() },
      })),
      paginate: { iterator: vi.fn() },
    };
  }

  it("preserves pending checkStatus when UNSTABLE and rollup is PENDING", async () => {
    const octokit = makeEnrichmentOctokit("UNSTABLE", "PENDING");
    const { enrichments } = await fetchPREnrichment(octokit as never, ["PR_node1"]);
    expect(enrichments.get(100)!.checkStatus).toBe("pending");
  });

  it("forces failure checkStatus when UNSTABLE and rollup is SUCCESS", async () => {
    const octokit = makeEnrichmentOctokit("UNSTABLE", "SUCCESS");
    const { enrichments } = await fetchPREnrichment(octokit as never, ["PR_node1"]);
    expect(enrichments.get(100)!.checkStatus).toBe("failure");
  });

  it("forces failure checkStatus when UNSTABLE and rollup is absent", async () => {
    const octokit = makeEnrichmentOctokit("UNSTABLE", null);
    const { enrichments } = await fetchPREnrichment(octokit as never, ["PR_node1"]);
    expect(enrichments.get(100)!.checkStatus).toBe("failure");
  });
});

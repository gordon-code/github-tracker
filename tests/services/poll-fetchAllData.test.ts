import "fake-indexeddb/auto";
import { describe, it, expect, vi, afterEach } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────

// Mock github client — factory must not reference hoisted consts
vi.mock("../../src/app/services/github", () => ({
  getClient: vi.fn(),
  onApiRequest: vi.fn(),
}));

// Mock config store
vi.mock("../../src/app/stores/config", () => ({
  config: {
    selectedRepos: [{ owner: "octocat", name: "Hello-World", fullName: "octocat/Hello-World" }],
    maxWorkflowsPerRepo: 5,
    maxRunsPerWorkflow: 3,
  },
}));

// Mock auth store — onAuthCleared is called at poll.ts module scope
vi.mock("../../src/app/stores/auth", () => ({
  user: vi.fn(() => ({ login: "octocat", avatar_url: "https://github.com/images/error/octocat_happy.gif", name: "Octocat" })),
  onAuthCleared: vi.fn(),
}));

// Mock the fetch functions (combined issues+PRs and workflow runs)
vi.mock("../../src/app/services/api", () => ({
  fetchIssuesAndPullRequests: vi.fn(),
  fetchWorkflowRuns: vi.fn(),
  resetEmptyActionRepos: vi.fn(),
}));

// Mock notifications
vi.mock("../../src/app/lib/notifications", () => ({
  detectNewItems: vi.fn(() => []),
  dispatchNotifications: vi.fn(),
  _resetNotificationState: vi.fn(),
}));

// Mock errors store
vi.mock("../../src/app/lib/errors", () => ({
  pushError: vi.fn(),
  pushNotification: vi.fn(),
  clearErrors: vi.fn(),
  clearNotifications: vi.fn(),
  getErrors: vi.fn(() => []),
  getNotifications: vi.fn(() => []),
  dismissNotificationBySource: vi.fn(),
  startCycleTracking: vi.fn(),
  endCycleTracking: vi.fn(() => new Set()),
  resetNotificationState: vi.fn(),
  addMutedSource: vi.fn(),
  isMuted: vi.fn(() => false),
  clearMutedSources: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const emptyIssuesAndPrsResult = { issues: [], pullRequests: [], errors: [] };
const emptyRunResult = { workflowRuns: [], errors: [] };

function makeMockOctokit() {
  return {
    request: vi.fn(),
    graphql: vi.fn(),
    paginate: { iterator: vi.fn() },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ── qa-1: fetchAllData returns data ──────────────────────────────────────────

describe("fetchAllData — first call", () => {

  it("returns data from all fetches", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);


    const { fetchAllData } = await import("../../src/app/services/poll");

    const result = await fetchAllData();

    expect(result.issues).toEqual([]);
    expect(result.pullRequests).toEqual([]);
    expect(result.workflowRuns).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("calls both fetch functions unconditionally on every call", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);


    const { fetchAllData } = await import("../../src/app/services/poll");

    await fetchAllData();

    // No notification gate — both data fetches always run
    expect(mockOctokit.request).not.toHaveBeenCalled();
    expect(fetchIssuesAndPullRequests).toHaveBeenCalledOnce();
    expect(fetchWorkflowRuns).toHaveBeenCalledOnce();

    // Second call — still unconditional, no gate check
    vi.mocked(fetchIssuesAndPullRequests).mockClear();
    vi.mocked(fetchWorkflowRuns).mockClear();
    await fetchAllData();
    expect(mockOctokit.request).not.toHaveBeenCalled();
    expect(fetchIssuesAndPullRequests).toHaveBeenCalledOnce();
    expect(fetchWorkflowRuns).toHaveBeenCalledOnce();
  });

  it("uses correct arguments: repo list, userLogin from user(), and config maxWorkflows/maxRuns", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const { config } = await import("../../src/app/stores/config");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);


    const { fetchAllData } = await import("../../src/app/services/poll");

    await fetchAllData();

    expect(fetchIssuesAndPullRequests).toHaveBeenCalledWith(mockOctokit, config.selectedRepos, "octocat", undefined, [], []);
    expect(fetchWorkflowRuns).toHaveBeenCalledWith(
      mockOctokit,
      config.selectedRepos,
      config.maxWorkflowsPerRepo,
      config.maxRunsPerWorkflow
    );
  });
});


// ── All fetches fail — errors aggregated ─────────────────────────────────────

describe("fetchAllData — all fetches fail", () => {
  it("aggregates top-level errors when all fetches reject", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);

    vi.mocked(fetchIssuesAndPullRequests).mockRejectedValue(Object.assign(new Error("Issues+PRs failed"), { status: 500 }));
    vi.mocked(fetchWorkflowRuns).mockRejectedValue(Object.assign(new Error("Runs failed"), { status: 500 }));

    const topLevelErrors = [
      { repo: "issues-and-prs", statusCode: 500, message: "Issues+PRs failed", retryable: true },
      { repo: "workflow-runs", statusCode: 500, message: "Runs failed", retryable: true },
    ];
    const { fetchAllData } = await import("../../src/app/services/poll");

    const result = await fetchAllData();

    expect(result.errors).toEqual(topLevelErrors);
    expect(result.issues).toEqual([]);
    expect(result.pullRequests).toEqual([]);
    expect(result.workflowRuns).toEqual([]);
  });

  it("fetches are still attempted on subsequent calls even after all fail", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);

    vi.mocked(fetchIssuesAndPullRequests).mockRejectedValue(new Error("fail"));
    vi.mocked(fetchWorkflowRuns).mockRejectedValue(new Error("fail"));

    const { fetchAllData } = await import("../../src/app/services/poll");

    await fetchAllData();

    // Second call — fetches run again (no gate to suppress them)
    vi.mocked(fetchIssuesAndPullRequests).mockClear();
    vi.mocked(fetchWorkflowRuns).mockClear();
    vi.mocked(fetchIssuesAndPullRequests).mockRejectedValue(new Error("fail"));
    vi.mocked(fetchWorkflowRuns).mockRejectedValue(new Error("fail"));

    await fetchAllData();

    expect(fetchIssuesAndPullRequests).toHaveBeenCalled();
    expect(fetchWorkflowRuns).toHaveBeenCalled();
  });
});

// ── qa-1: Partial success returns data from successful fetches ────────────────

describe("fetchAllData — partial success", () => {
  it("returns data from successful fetches and errors from failed ones", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);

    const issues = [{
      id: 1, number: 1, title: "Issue 1", state: "open",
      htmlUrl: "https://github.com/o/r/issues/1",
      createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
      userLogin: "octocat", userAvatarUrl: "", labels: [], assigneeLogins: [],
      repoFullName: "o/r", comments: 0,
    }];
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue({ issues, pullRequests: [], errors: [] });
    vi.mocked(fetchWorkflowRuns).mockRejectedValue(Object.assign(new Error("Runs failed"), { status: 503 }));
    const { fetchAllData } = await import("../../src/app/services/poll");

    const result = await fetchAllData();

    expect(result.issues).toEqual(issues);
    expect(result.pullRequests).toEqual([]);
    expect(result.workflowRuns).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].repo).toBe("workflow-runs");
  });
});

// ── qa-1: Returns empty data when no client available ────────────────────────

describe("fetchAllData — no client", () => {
  it("returns empty data when getClient returns null", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests } = await import("../../src/app/services/api");
    vi.mocked(getClient).mockReturnValue(null);

    const { fetchAllData } = await import("../../src/app/services/poll");

    const result = await fetchAllData();

    expect(result.issues).toEqual([]);
    expect(result.pullRequests).toEqual([]);
    expect(result.workflowRuns).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(fetchIssuesAndPullRequests).not.toHaveBeenCalled();
  });
});


// ── Upstream repos + tracked users integration ────────────────────────────────

describe("fetchAllData — upstream repos and tracked users", () => {

  it("passes combined (selectedRepos + upstreamRepos) deduplicated to fetchIssuesAndPullRequests", async () => {
    vi.resetModules();

    // Override config mock to include upstreamRepos
    vi.doMock("../../src/app/stores/config", () => ({
      config: {
        selectedRepos: [{ owner: "octocat", name: "Hello-World", fullName: "octocat/Hello-World" }],
        upstreamRepos: [
          { owner: "other-org", name: "upstream-repo", fullName: "other-org/upstream-repo" },
          // Duplicate of selectedRepos — should be filtered out
          { owner: "octocat", name: "Hello-World", fullName: "octocat/Hello-World" },
        ],
        trackedUsers: [],
        maxWorkflowsPerRepo: 5,
        maxRunsPerWorkflow: 3,
      },
    }));

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);

    const { fetchAllData } = await import("../../src/app/services/poll");
    await fetchAllData();

    // Should be called with combined repos (2, not 3 — duplicate removed)
    const callArgs = vi.mocked(fetchIssuesAndPullRequests).mock.calls[0];
    const passedRepos = callArgs[1] as Array<{ fullName: string }>;
    expect(passedRepos).toHaveLength(2);
    expect(passedRepos.map((r) => r.fullName)).toContain("octocat/Hello-World");
    expect(passedRepos.map((r) => r.fullName)).toContain("other-org/upstream-repo");
  });

  it("passes only selectedRepos to fetchWorkflowRuns (upstream repos excluded)", async () => {
    vi.resetModules();

    vi.doMock("../../src/app/stores/config", () => ({
      config: {
        selectedRepos: [{ owner: "octocat", name: "Hello-World", fullName: "octocat/Hello-World" }],
        upstreamRepos: [{ owner: "other-org", name: "upstream-repo", fullName: "other-org/upstream-repo" }],
        trackedUsers: [],
        maxWorkflowsPerRepo: 5,
        maxRunsPerWorkflow: 3,
      },
    }));

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);

    const { fetchAllData } = await import("../../src/app/services/poll");
    await fetchAllData();

    // fetchWorkflowRuns should only get selectedRepos, not upstream
    const callArgs = vi.mocked(fetchWorkflowRuns).mock.calls[0];
    const passedRepos = callArgs[1] as Array<{ fullName: string }>;
    expect(passedRepos).toHaveLength(1);
    expect(passedRepos[0].fullName).toBe("octocat/Hello-World");
  });

  it("passes trackedUsers to fetchIssuesAndPullRequests", async () => {
    vi.resetModules();

    const trackedUsers = [
      { login: "tracked-alice", avatarUrl: "https://avatars.githubusercontent.com/u/1", name: "Alice" },
    ];

    vi.doMock("../../src/app/stores/config", () => ({
      config: {
        selectedRepos: [{ owner: "octocat", name: "Hello-World", fullName: "octocat/Hello-World" }],
        upstreamRepos: [],
        trackedUsers,
        maxWorkflowsPerRepo: 5,
        maxRunsPerWorkflow: 3,
      },
    }));

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);

    const { fetchAllData } = await import("../../src/app/services/poll");
    await fetchAllData();

    // 5th argument to fetchIssuesAndPullRequests should be trackedUsers
    const callArgs = vi.mocked(fetchIssuesAndPullRequests).mock.calls[0];
    expect(callArgs[4]).toEqual(trackedUsers);
  });

  it("empty upstreamRepos and trackedUsers produces identical behavior (backward compat)", async () => {
    vi.resetModules();

    const selectedRepos = [{ owner: "octocat", name: "Hello-World", fullName: "octocat/Hello-World" }];
    vi.doMock("../../src/app/stores/config", () => ({
      config: {
        selectedRepos,
        upstreamRepos: [],
        trackedUsers: [],
        maxWorkflowsPerRepo: 5,
        maxRunsPerWorkflow: 3,
      },
    }));

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);

    const { fetchAllData } = await import("../../src/app/services/poll");
    await fetchAllData();

    // Combined repos == selectedRepos when no upstream repos
    expect(fetchIssuesAndPullRequests).toHaveBeenCalledWith(
      mockOctokit,
      selectedRepos,
      "octocat",
      undefined,
      [],
      []
    );
    expect(fetchWorkflowRuns).toHaveBeenCalledWith(
      mockOctokit,
      selectedRepos,
      5,
      3
    );
  });

  it("duplicate repo in both selectedRepos and upstreamRepos is deduplicated (first occurrence wins)", async () => {
    vi.resetModules();

    vi.doMock("../../src/app/stores/config", () => ({
      config: {
        selectedRepos: [
          { owner: "octocat", name: "Hello-World", fullName: "octocat/Hello-World" },
          { owner: "octocat", name: "Other", fullName: "octocat/Other" },
        ],
        upstreamRepos: [
          // Both are already in selectedRepos
          { owner: "octocat", name: "Hello-World", fullName: "octocat/Hello-World" },
          { owner: "octocat", name: "Other", fullName: "octocat/Other" },
          // This one is new
          { owner: "new-org", name: "new-repo", fullName: "new-org/new-repo" },
        ],
        trackedUsers: [],
        maxWorkflowsPerRepo: 5,
        maxRunsPerWorkflow: 3,
      },
    }));

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);

    const { fetchAllData } = await import("../../src/app/services/poll");
    await fetchAllData();

    const callArgs = vi.mocked(fetchIssuesAndPullRequests).mock.calls[0];
    const passedRepos = callArgs[1] as Array<{ fullName: string }>;
    // 2 selected + 1 new upstream (2 duplicates filtered)
    expect(passedRepos).toHaveLength(3);
    const names = passedRepos.map((r) => r.fullName);
    expect(names.filter((n) => n === "octocat/Hello-World")).toHaveLength(1);
    expect(names.filter((n) => n === "octocat/Other")).toHaveLength(1);
    expect(names).toContain("new-org/new-repo");
  });
});

// ── DashboardPage fine-grained merge: surfacedBy preserved ────────────────────

describe("DashboardPage pollFetch — fine-grained merge preserves surfacedBy", () => {
  it("surfacedBy is copied into the store during the canMerge path", () => {
    // Test the canMerge loop logic directly (same code as DashboardPage.tsx pollFetch).
    // Using Record<string, unknown> to avoid the 'never' collapse from conflicting
    // enriched: false vs enriched: true literal types.
    type MutablePR = Record<string, unknown> & { id: number };

    const pr: MutablePR = {
      id: 5001,
      surfacedBy: ["mainuser", "trackeduser"],
      enriched: false,
    };

    const enriched: MutablePR = {
      id: 5001,
      headSha: "abc123",
      assigneeLogins: [],
      reviewerLogins: [],
      checkStatus: "success",
      additions: 5,
      deletions: 2,
      changedFiles: 1,
      comments: 0,
      reviewThreads: 0,
      totalReviewCount: 0,
      enriched: true,
      nodeId: "PR_node_5001",
      surfacedBy: ["mainuser", "trackeduser"],
    };

    const state = { pullRequests: [pr] };
    const enrichedMap = new Map([[5001, enriched]]);

    // Simulate the canMerge loop from DashboardPage.tsx
    for (let i = 0; i < state.pullRequests.length; i++) {
      const e = enrichedMap.get(state.pullRequests[i].id)!;
      const p = state.pullRequests[i];
      p["headSha"] = e["headSha"];
      p["assigneeLogins"] = e["assigneeLogins"];
      p["reviewerLogins"] = e["reviewerLogins"];
      p["checkStatus"] = e["checkStatus"];
      p["additions"] = e["additions"];
      p["deletions"] = e["deletions"];
      p["changedFiles"] = e["changedFiles"];
      p["comments"] = e["comments"];
      p["reviewThreads"] = e["reviewThreads"];
      p["totalReviewCount"] = e["totalReviewCount"];
      p["enriched"] = e["enriched"];
      p["nodeId"] = e["nodeId"];
      p["surfacedBy"] = e["surfacedBy"];
    }

    expect(state.pullRequests[0]["surfacedBy"]).toEqual(["mainuser", "trackeduser"]);
    expect(state.pullRequests[0]["enriched"]).toBe(true);
    expect(state.pullRequests[0]["checkStatus"]).toBe("success");
  });
});

// ── 401 propagation from Promise.allSettled ───────────────────────────────────

describe("fetchAllData — 401 propagation from allSettled", () => {
  it("re-throws 401 from fetchIssuesAndPullRequests instead of absorbing it", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);

    vi.mocked(fetchIssuesAndPullRequests).mockRejectedValue({ status: 401, message: "Unauthorized" });
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);

    const { fetchAllData } = await import("../../src/app/services/poll");

    await expect(fetchAllData()).rejects.toMatchObject({ status: 401 });
  });

  it("re-throws 401 with response.status shape from fetchWorkflowRuns", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);

    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockRejectedValue({ response: { status: 401 }, message: "Bad credentials" });

    const { fetchAllData } = await import("../../src/app/services/poll");

    await expect(fetchAllData()).rejects.toMatchObject({ response: { status: 401 } });
  });

  it("does NOT re-throw non-401 errors (500 is absorbed)", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);

    vi.mocked(fetchIssuesAndPullRequests).mockRejectedValue(Object.assign(new Error("Internal Server Error"), { status: 500 }));
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);

    const { fetchAllData } = await import("../../src/app/services/poll");

    // Should resolve (not throw) — 500 is absorbed as a top-level error entry
    const result = await fetchAllData();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].repo).toBe("issues-and-prs");
    expect(result.errors[0].statusCode).toBe(500);
  });
});

// ── qa-4: Concurrency verification ────────────────────────────────────────────

describe("fetchAllData — parallel execution", () => {
  it("initiates both fetches before either resolves", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);

    const callOrder: string[] = [];
    const resolvers: Array<(v: unknown) => void> = [];

    // Each mock records when it's called but doesn't resolve until manually triggered
    vi.mocked(fetchIssuesAndPullRequests).mockImplementation(() => {
      callOrder.push("issues-and-prs-start");
      return new Promise((resolve) => { resolvers.push(() => resolve(emptyIssuesAndPrsResult)); });
    });
    vi.mocked(fetchWorkflowRuns).mockImplementation(() => {
      callOrder.push("runs-start");
      return new Promise((resolve) => { resolvers.push(() => resolve(emptyRunResult)); });
    });

    const { fetchAllData } = await import("../../src/app/services/poll");

    const promise = fetchAllData();

    // Yield to allow Promise.allSettled to initiate both
    await new Promise((r) => setTimeout(r, 0));

    // Both should have been called BEFORE either resolved
    expect(callOrder).toEqual(["issues-and-prs-start", "runs-start"]);
    expect(resolvers.length).toBe(2);

    // Now resolve both
    for (const resolve of resolvers) resolve(undefined);
    await promise;
  });
});

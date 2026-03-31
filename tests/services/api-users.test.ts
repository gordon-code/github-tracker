import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateGitHubUser, discoverUpstreamRepos, fetchIssuesAndPullRequests } from "../../src/app/services/api";
import type { TrackedUser } from "../../src/app/stores/config";

vi.mock("../../src/app/lib/errors", () => ({
  pushNotification: vi.fn(),
  pushError: vi.fn(),
  getErrors: vi.fn().mockReturnValue([]),
  dismissError: vi.fn(),
  getNotifications: vi.fn().mockReturnValue([]),
  getUnreadCount: vi.fn().mockReturnValue(0),
  markAllAsRead: vi.fn(),
}));

vi.mock("../../src/app/services/github", () => ({
  getClient: vi.fn(),
  cachedRequest: vi.fn(),
  updateGraphqlRateLimit: vi.fn(),
  updateRateLimitFromHeaders: vi.fn(),
  clearCache: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOctokit(
  requestImpl: (route: string, params?: unknown) => Promise<unknown> = async () => ({}),
  graphqlImpl: (query: string, variables?: unknown) => Promise<unknown> = async () => ({})
) {
  return {
    request: vi.fn(requestImpl),
    graphql: vi.fn(graphqlImpl),
    paginate: { iterator: vi.fn() },
  };
}

function makeUserResponse(overrides: {
  login?: string;
  avatar_url?: string;
  name?: string | null;
  type?: string;
} = {}) {
  return {
    data: {
      login: overrides.login ?? "octocat",
      avatar_url: overrides.avatar_url ?? "https://avatars.githubusercontent.com/u/583231?v=4",
      name: overrides.name !== undefined ? overrides.name : "The Octocat",
      type: overrides.type ?? "User",
    },
  };
}

let searchPageIdCounter = 100000;

/** Build a minimal GraphQL search response page with the given repo names. */
function makeSearchPage(repoNames: string[], hasNextPage = false) {
  return {
    search: {
      issueCount: repoNames.length,
      pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor-1" : null },
      nodes: repoNames.map((nameWithOwner) => ({
        databaseId: searchPageIdCounter++,
        number: 1,
        title: "Test",
        state: "OPEN",
        url: `https://github.com/${nameWithOwner}/issues/1`,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        author: { login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/u/583231" },
        labels: { nodes: [] },
        assignees: { nodes: [] },
        repository: { nameWithOwner },
        comments: { totalCount: 0 },
        // PR fields (ignored by issue processNode, but needed for shape)
        isDraft: false,
        headRefName: "main",
        baseRefName: "main",
        reviewDecision: null,
        id: "PR_xxx",
        headRefOid: "",
        headRepository: null,
        mergeStateStatus: "UNKNOWN",
        reviewRequests: { nodes: [] },
        deletions: 0,
        additions: 0,
        changedFiles: 0,
        reviewThreads: { totalCount: 0 },
        latestReviews: { totalCount: 0, nodes: [] },
        commits: { nodes: [] },
      })),
    },
    rateLimit: { remaining: 4990, resetAt: "2024-01-01T01:00:00Z" },
  };
}

// ── validateGitHubUser ────────────────────────────────────────────────────────

describe("validateGitHubUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns user data on 200 response", async () => {
    const octokit = makeOctokit(async () => makeUserResponse());
    const result = await validateGitHubUser(octokit as never, "octocat");
    expect(result).toEqual({
      login: "octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
      name: "The Octocat",
      type: "user",
    });
    expect(octokit.request).toHaveBeenCalledWith("GET /users/{username}", { username: "octocat" });
  });

  it("returns null for 404", async () => {
    const octokit = makeOctokit(async () => {
      const err = Object.assign(new Error("Not Found"), { status: 404 });
      throw err;
    });
    const result = await validateGitHubUser(octokit as never, "nonexistent-user");
    expect(result).toBeNull();
    expect(octokit.request).toHaveBeenCalledOnce();
  });

  it("returns null for invalid login without making API call", async () => {
    const octokit = makeOctokit(async () => {
      throw new Error("should not be called");
    });
    // Bracket chars are not in VALID_TRACKED_LOGIN
    const result = await validateGitHubUser(octokit as never, "bad[user]");
    expect(result).toBeNull();
    expect(octokit.request).not.toHaveBeenCalled();
  });

  it("returns null for login exceeding 39 chars without making API call", async () => {
    const octokit = makeOctokit(async () => {
      throw new Error("should not be called");
    });
    const longLogin = "a".repeat(40);
    const result = await validateGitHubUser(octokit as never, longLogin);
    expect(result).toBeNull();
    expect(octokit.request).not.toHaveBeenCalled();
  });

  it("returns null for empty login without making API call", async () => {
    const octokit = makeOctokit(async () => {
      throw new Error("should not be called");
    });
    const result = await validateGitHubUser(octokit as never, "");
    expect(result).toBeNull();
    expect(octokit.request).not.toHaveBeenCalled();
  });

  it("propagates network errors (non-404)", async () => {
    const octokit = makeOctokit(async () => {
      const err = Object.assign(new Error("Network Error"), { status: 500 });
      throw err;
    });
    await expect(validateGitHubUser(octokit as never, "octocat")).rejects.toThrow("Network Error");
  });

  it("uses avatar fallback for invalid avatar URL", async () => {
    const octokit = makeOctokit(async () =>
      makeUserResponse({ avatar_url: "https://evil.com/avatar.png" })
    );
    const result = await validateGitHubUser(octokit as never, "octocat");
    expect(result?.avatarUrl).toBe("https://avatars.githubusercontent.com/u/0");
  });

  it("accepts valid avatar URL from GitHub CDN", async () => {
    const cdnUrl = "https://avatars.githubusercontent.com/u/12345?v=4";
    const octokit = makeOctokit(async () => makeUserResponse({ avatar_url: cdnUrl }));
    const result = await validateGitHubUser(octokit as never, "octocat");
    expect(result?.avatarUrl).toBe(cdnUrl);
  });

  it("returns null name when API returns null", async () => {
    const octokit = makeOctokit(async () => makeUserResponse({ name: null }));
    const result = await validateGitHubUser(octokit as never, "octocat");
    expect(result?.name).toBeNull();
  });

  it("normalizes login to lowercase", async () => {
    const octokit = makeOctokit(async () => makeUserResponse({ login: "OctoCat" }));
    const result = await validateGitHubUser(octokit as never, "octocat");
    expect(result?.login).toBe("octocat");
  });
});

// ── discoverUpstreamRepos ─────────────────────────────────────────────────────

describe("discoverUpstreamRepos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchPageIdCounter = 100000;
  });

  it("returns repos found in issue and PR search results", async () => {
    const octokit = makeOctokit(
      async () => ({}),
      async (_query: string, vars: unknown) => {
        const v = vars as { q: string };
        if (v.q.includes("is:issue")) return makeSearchPage(["org/repo-a", "org/repo-b"]);
        if (v.q.includes("is:pr")) return makeSearchPage(["org/repo-c"]);
        return makeSearchPage([]);
      }
    );

    const result = await discoverUpstreamRepos(octokit as never, "octocat", new Set());
    const names = result.map((r) => r.fullName);
    expect(names).toContain("org/repo-a");
    expect(names).toContain("org/repo-b");
    expect(names).toContain("org/repo-c");
    expect(result.length).toBe(3);
  });

  it("deduplicates repos appearing in both issue and PR results", async () => {
    const octokit = makeOctokit(
      async () => ({}),
      async (_query: string, vars: unknown) => {
        const v = vars as { q: string };
        // Both searches return the same repo
        if (v.q.includes("is:issue")) return makeSearchPage(["org/shared-repo", "org/issue-only"]);
        if (v.q.includes("is:pr")) return makeSearchPage(["org/shared-repo", "org/pr-only"]);
        return makeSearchPage([]);
      }
    );

    const result = await discoverUpstreamRepos(octokit as never, "octocat", new Set());
    const names = result.map((r) => r.fullName);
    // shared-repo should appear only once
    expect(names.filter((n) => n === "org/shared-repo").length).toBe(1);
    expect(names).toContain("org/issue-only");
    expect(names).toContain("org/pr-only");
    expect(result.length).toBe(3);
  });

  it("excludes repos in the excludeRepos set", async () => {
    const octokit = makeOctokit(
      async () => ({}),
      async (_query: string, vars: unknown) => {
        const v = vars as { q: string };
        if (v.q.includes("is:issue")) return makeSearchPage(["org/included", "org/excluded"]);
        return makeSearchPage([]);
      }
    );

    const result = await discoverUpstreamRepos(
      octokit as never,
      "octocat",
      new Set(["org/excluded"])
    );
    const names = result.map((r) => r.fullName);
    expect(names).toContain("org/included");
    expect(names).not.toContain("org/excluded");
  });

  it("returns empty array for empty search results", async () => {
    const octokit = makeOctokit(
      async () => ({}),
      async () => makeSearchPage([])
    );

    const result = await discoverUpstreamRepos(octokit as never, "octocat", new Set());
    expect(result).toEqual([]);
  });

  it("returns empty array for invalid userLogin without making API calls", async () => {
    const octokit = makeOctokit(
      async () => ({}),
      async () => {
        throw new Error("should not be called");
      }
    );

    const result = await discoverUpstreamRepos(octokit as never, "bad[login]", new Set());
    expect(result).toEqual([]);
    expect(octokit.graphql).not.toHaveBeenCalled();
  });

  it("returns empty array for login exceeding 39 chars", async () => {
    const octokit = makeOctokit(
      async () => ({}),
      async () => {
        throw new Error("should not be called");
      }
    );

    const result = await discoverUpstreamRepos(octokit as never, "a".repeat(40), new Set());
    expect(result).toEqual([]);
    expect(octokit.graphql).not.toHaveBeenCalled();
  });

  it("returns partial results when one search fails", async () => {
    const { pushNotification } = await import("../../src/app/lib/errors");
    const octokit = makeOctokit(
      async () => ({}),
      async (_query: string, vars: unknown) => {
        const v = vars as { q: string };
        if (v.q.includes("is:issue")) return makeSearchPage(["org/from-issues"]);
        // PR search throws a non-partial error
        throw new Error("GraphQL timeout");
      }
    );

    const result = await discoverUpstreamRepos(octokit as never, "octocat", new Set());
    // Should still get the issue results
    const names = result.map((r) => r.fullName);
    expect(names).toContain("org/from-issues");
    // And should have pushed a warning notification
    expect(pushNotification).toHaveBeenCalled();
  });

  it("respects the 100-repo cap", async () => {
    // Generate 120 unique repo names in the issue search
    const manyRepos = Array.from({ length: 120 }, (_, i) => `org/repo-${i.toString().padStart(3, "0")}`);

    const octokit = makeOctokit(
      async () => ({}),
      async (_query: string, vars: unknown) => {
        const v = vars as { q: string };
        if (v.q.includes("is:issue")) return makeSearchPage(manyRepos);
        return makeSearchPage([]);
      }
    );

    const result = await discoverUpstreamRepos(octokit as never, "octocat", new Set());
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it("returns results sorted alphabetically by fullName", async () => {
    const octokit = makeOctokit(
      async () => ({}),
      async (_query: string, vars: unknown) => {
        const v = vars as { q: string };
        if (v.q.includes("is:issue")) return makeSearchPage(["zzz/repo", "aaa/repo", "mmm/repo"]);
        return makeSearchPage([]);
      }
    );

    const result = await discoverUpstreamRepos(octokit as never, "octocat", new Set());
    const names = result.map((r) => r.fullName);
    expect(names).toEqual(["aaa/repo", "mmm/repo", "zzz/repo"]);
  });

  it("correctly parses owner and name from fullName", async () => {
    const octokit = makeOctokit(
      async () => ({}),
      async (_query: string, vars: unknown) => {
        const v = vars as { q: string };
        if (v.q.includes("is:issue")) return makeSearchPage(["my-org/my-repo"]);
        return makeSearchPage([]);
      }
    );

    const result = await discoverUpstreamRepos(octokit as never, "octocat", new Set());
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ owner: "my-org", name: "my-repo", fullName: "my-org/my-repo" });
  });

  it("discovers repos from tracked users in addition to primary user", async () => {
    const octokit = makeOctokit(
      async () => ({}),
      async (_query: string, vars: unknown) => {
        const v = vars as { q: string };
        if (v.q.includes("involves:primary") && v.q.includes("is:issue")) {
          return makeSearchPage(["org/primary-repo"]);
        }
        if (v.q.includes("involves:tracked1") && v.q.includes("is:issue")) {
          return makeSearchPage(["org/tracked1-repo"]);
        }
        return makeSearchPage([]);
      }
    );

    const trackedUsers = [makeTrackedUser("tracked1")];
    const result = await discoverUpstreamRepos(octokit as never, "primary", new Set(), trackedUsers);
    const names = result.map((r) => r.fullName);
    expect(names).toContain("org/primary-repo");
    expect(names).toContain("org/tracked1-repo");
  });

  it("deduplicates repos found by both primary and tracked users", async () => {
    const octokit = makeOctokit(
      async () => ({}),
      async (_query: string, vars: unknown) => {
        const v = vars as { q: string };
        if (v.q.includes("is:issue")) {
          // Both users discover the same repo
          return makeSearchPage(["org/shared-repo"]);
        }
        return makeSearchPage([]);
      }
    );

    const trackedUsers = [makeTrackedUser("tracked1")];
    const result = await discoverUpstreamRepos(octokit as never, "primary", new Set(), trackedUsers);
    expect(result).toHaveLength(1);
    expect(result[0].fullName).toBe("org/shared-repo");
  });
});

// ── multi-user search (fetchIssuesAndPullRequests with trackedUsers) ───────────

/**
 * Build a LightCombinedSearchResponse for the LIGHT_COMBINED_SEARCH_QUERY.
 * issueNodes: array of {databaseId, repoFullName} shapes (simplified).
 * prNodes: same.
 */
function makeLightCombinedResponse(
  issueItems: Array<{ databaseId: number; repoFullName: string }>,
  prItems: Array<{ databaseId: number; nodeId: string; repoFullName: string }> = []
) {
  const makeIssueNode = (item: { databaseId: number; repoFullName: string }) => ({
    databaseId: item.databaseId,
    number: item.databaseId,
    title: `Issue ${item.databaseId}`,
    state: "OPEN",
    url: `https://github.com/${item.repoFullName}/issues/${item.databaseId}`,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    author: { login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/u/583231" },
    labels: { nodes: [] },
    assignees: { nodes: [] },
    repository: { nameWithOwner: item.repoFullName },
    comments: { totalCount: 0 },
  });

  const makePRNode = (item: { databaseId: number; nodeId: string; repoFullName: string }) => ({
    id: item.nodeId,
    databaseId: item.databaseId,
    number: item.databaseId,
    title: `PR ${item.databaseId}`,
    state: "OPEN",
    isDraft: false,
    url: `https://github.com/${item.repoFullName}/pull/${item.databaseId}`,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    author: { login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/u/583231" },
    repository: { nameWithOwner: item.repoFullName },
    headRefName: "feature",
    baseRefName: "main",
    reviewDecision: null,
    labels: { nodes: [] },
  });

  return {
    issues: {
      issueCount: issueItems.length,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: issueItems.map(makeIssueNode),
    },
    prInvolves: {
      issueCount: prItems.length,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: prItems.map(makePRNode),
    },
    prReviewReq: {
      issueCount: 0,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [],
    },
    rateLimit: { remaining: 4990, resetAt: "2024-01-01T01:00:00Z" },
  };
}

/** Empty heavy backfill response */
function makeBackfillResponse(databaseIds: number[] = []) {
  return {
    nodes: databaseIds.map((id) => ({
      databaseId: id,
      headRefOid: "abc123",
      headRepository: null,
      mergeStateStatus: "CLEAN",
      assignees: { nodes: [] },
      reviewRequests: { nodes: [] },
      latestReviews: { totalCount: 0, nodes: [] },
      additions: 5,
      deletions: 2,
      changedFiles: 1,
      comments: { totalCount: 0 },
      reviewThreads: { totalCount: 0 },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    })),
    rateLimit: { remaining: 4980, resetAt: "2024-01-01T01:00:00Z" },
  };
}

/** Tracked user fixture */
function makeTrackedUser(login: string): TrackedUser {
  return {
    login,
    avatarUrl: `https://avatars.githubusercontent.com/u/99999`,
    name: login,
    type: "user",
  };
}

/** Repo ref fixture */
function makeRepo(fullName: string) {
  const [owner, name] = fullName.split("/");
  return { owner, name, fullName };
}

describe("multi-user search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("same issue from main and tracked user gets merged surfacedBy", async () => {
    // Issue 1 appears in both main user and tracked user results
    const sharedIssueId = 1001;
    const repo = makeRepo("org/repo");

    const octokit = makeOctokit(
      async () => ({}),
      async (_query: string, vars: unknown) => {
        const v = vars as Record<string, unknown>;
        if ("ids" in v) return makeBackfillResponse([]);
        // Both main and tracked user searches are now repo-scoped;
        // distinguish by the involves: login in the query
        const issueQ = v["issueQ"] as string | undefined;
        if (issueQ?.includes("involves:mainuser") || issueQ?.includes("involves:trackeduser")) {
          return makeLightCombinedResponse([{ databaseId: sharedIssueId, repoFullName: "org/repo" }]);
        }
        return makeLightCombinedResponse([]);
      }
    );

    const result = await fetchIssuesAndPullRequests(
      octokit as never, [repo], "mainuser", undefined, [makeTrackedUser("trackeduser")]
    );

    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue.surfacedBy).toContain("mainuser");
    expect(issue.surfacedBy).toContain("trackeduser");
    expect(issue.surfacedBy).toHaveLength(2);
  });

  it("unique issues from tracked user appear with surfacedBy containing only tracked login", async () => {
    const mainIssueId = 1001;
    const trackedOnlyIssueId = 2001;
    const repo = makeRepo("org/repo");

    const octokit = makeOctokit(
      async () => ({}),
      async (_query: string, vars: unknown) => {
        const v = vars as Record<string, unknown>;
        if ("ids" in v) return makeBackfillResponse([]);
        const issueQ = v["issueQ"] as string | undefined;
        if (issueQ?.includes("involves:mainuser")) {
          return makeLightCombinedResponse([{ databaseId: mainIssueId, repoFullName: "org/repo" }]);
        }
        if (issueQ?.includes("involves:trackeduser")) {
          // Tracked user has both the shared one and a unique one
          return makeLightCombinedResponse([
            { databaseId: mainIssueId, repoFullName: "org/repo" },
            { databaseId: trackedOnlyIssueId, repoFullName: "org/repo" },
          ]);
        }
        return makeLightCombinedResponse([]);
      }
    );

    const result = await fetchIssuesAndPullRequests(
      octokit as never, [repo], "mainuser", undefined, [makeTrackedUser("trackeduser")]
    );

    expect(result.issues).toHaveLength(2);
    const trackedOnly = result.issues.find((i) => i.id === trackedOnlyIssueId);
    expect(trackedOnly?.surfacedBy).toEqual(["trackeduser"]);
    const shared = result.issues.find((i) => i.id === mainIssueId);
    expect(shared?.surfacedBy).toContain("mainuser");
    expect(shared?.surfacedBy).toContain("trackeduser");
  });

  it("multiple tracked users results are all merged correctly", async () => {
    const sharedId = 1001;
    const userAOnlyId = 2001;
    const userBOnlyId = 3001;
    const repo = makeRepo("org/repo");

    const octokit = makeOctokit(
      async () => ({}),
      async (_query: string, vars: unknown) => {
        const v = vars as Record<string, unknown>;
        if ("ids" in v) return makeBackfillResponse([]);
        const issueQ = v["issueQ"] as string | undefined;
        if (issueQ?.includes("involves:mainuser")) {
          return makeLightCombinedResponse([{ databaseId: sharedId, repoFullName: "org/repo" }]);
        }
        if (issueQ?.includes("involves:usera")) {
          return makeLightCombinedResponse([
            { databaseId: sharedId, repoFullName: "org/repo" },
            { databaseId: userAOnlyId, repoFullName: "org/repo" },
          ]);
        }
        if (issueQ?.includes("involves:userb")) {
          return makeLightCombinedResponse([
            { databaseId: sharedId, repoFullName: "org/repo" },
            { databaseId: userBOnlyId, repoFullName: "org/repo" },
          ]);
        }
        return makeLightCombinedResponse([]);
      }
    );

    const result = await fetchIssuesAndPullRequests(
      octokit as never, [repo], "mainuser", undefined,
      [makeTrackedUser("usera"), makeTrackedUser("userb")]
    );

    const shared = result.issues.find((i) => i.id === sharedId);
    expect(shared?.surfacedBy).toContain("mainuser");
    expect(shared?.surfacedBy).toContain("usera");
    expect(shared?.surfacedBy).toContain("userb");

    const aOnly = result.issues.find((i) => i.id === userAOnlyId);
    expect(aOnly?.surfacedBy).toEqual(["usera"]);

    const bOnly = result.issues.find((i) => i.id === userBOnlyId);
    expect(bOnly?.surfacedBy).toEqual(["userb"]);
  });

  it("empty trackedUsers produces same results as before (backward compat)", async () => {
    const repo = makeRepo("org/repo");

    const octokit = makeOctokit(
      async () => ({}),
      async (_query: string, vars: unknown) => {
        const v = vars as Record<string, unknown>;
        if ("ids" in v) return makeBackfillResponse([]);
        return makeLightCombinedResponse([{ databaseId: 1001, repoFullName: "org/repo" }]);
      }
    );

    const result = await fetchIssuesAndPullRequests(
      octokit as never, [repo], "mainuser", undefined, []
    );

    expect(result.issues).toHaveLength(1);
    // surfacedBy is set to main user
    expect(result.issues[0].surfacedBy).toEqual(["mainuser"]);
  });

  it("tracked user search failure does not block main user results", async () => {
    const repo = makeRepo("org/repo");
    let callCount = 0;

    const octokit = makeOctokit(
      async () => ({}),
      async (_query: string, vars: unknown) => {
        const v = vars as Record<string, unknown>;
        if ("ids" in v) return makeBackfillResponse([]);
        const issueQ = v["issueQ"] as string | undefined;
        if (issueQ?.includes("involves:mainuser")) {
          return makeLightCombinedResponse([{ databaseId: 1001, repoFullName: "org/repo" }]);
        }
        // Tracked user search fails
        callCount++;
        throw new Error("tracked user search failed");
      }
    );

    const result = await fetchIssuesAndPullRequests(
      octokit as never, [repo], "mainuser", undefined, [makeTrackedUser("trackeduser")]
    );

    // Main user's issue is still returned
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].id).toBe(1001);
    expect(result.issues[0].surfacedBy).toEqual(["mainuser"]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(callCount).toBeGreaterThan(0);
  });

  it("surfacedBy survives Phase 2 PR enrichment", async () => {
    const prId = 5001;
    const prNodeId = "PR_node_5001";
    const repo = makeRepo("org/repo");

    const octokit = makeOctokit(
      async () => ({}),
      async (_query: string, vars: unknown) => {
        const v = vars as Record<string, unknown>;
        if ("ids" in v) {
          return makeBackfillResponse([prId]);
        }
        const issueQ = v["issueQ"] as string | undefined;
        if (issueQ?.includes("involves:mainuser") || issueQ?.includes("involves:trackeduser")) {
          return makeLightCombinedResponse([], [{ databaseId: prId, nodeId: prNodeId, repoFullName: "org/repo" }]);
        }
        return makeLightCombinedResponse([]);
      }
    );

    const result = await fetchIssuesAndPullRequests(
      octokit as never, [repo], "mainuser", undefined, [makeTrackedUser("trackeduser")]
    );

    expect(result.pullRequests).toHaveLength(1);
    const pr = result.pullRequests[0];
    expect(pr.surfacedBy).toContain("mainuser");
    expect(pr.surfacedBy).toContain("trackeduser");
    expect(pr.enriched).toBe(true);
    expect(pr.checkStatus).toBe("success");
  });

  it("empty repos returns empty results even with tracked users", async () => {
    const octokit = makeOctokit(
      async () => { throw new Error("should not be called"); },
      async () => { throw new Error("should not be called"); }
    );

    const result = await fetchIssuesAndPullRequests(
      octokit as never,
      [], // empty repos — tracked user searches are also repo-scoped
      "mainuser",
      undefined,
      [makeTrackedUser("trackeduser")]
    );

    expect(result.issues).toEqual([]);
    expect(result.pullRequests).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(octokit.graphql).not.toHaveBeenCalled();
  });

  it("surfacedBy logins are always lowercase", async () => {
    const repo = makeRepo("org/repo");

    const octokit = makeOctokit(
      async () => ({}),
      async (_query: string, vars: unknown) => {
        const v = vars as Record<string, unknown>;
        if ("ids" in v) return makeBackfillResponse([]);
        return makeLightCombinedResponse([{ databaseId: 1001, repoFullName: "org/repo" }]);
      }
    );

    const result = await fetchIssuesAndPullRequests(
      octokit as never, [repo], "MainUser", undefined, [makeTrackedUser("TrackedUser")]
    );

    expect(result.issues[0].surfacedBy).toEqual(["mainuser", "trackeduser"]);
  });

  it("onLightData fires with surfacedBy already annotated", async () => {
    const repo = makeRepo("org/repo");
    let lightDataSurfacedBy: string[] | undefined;

    const octokit = makeOctokit(
      async () => ({}),
      async (_query: string, vars: unknown) => {
        const v = vars as Record<string, unknown>;
        if ("ids" in v) return makeBackfillResponse([]);
        return makeLightCombinedResponse([{ databaseId: 1001, repoFullName: "org/repo" }]);
      }
    );

    await fetchIssuesAndPullRequests(
      octokit as never,
      [repo],
      "mainuser",
      (data) => { lightDataSurfacedBy = data.issues[0]?.surfacedBy; },
      []
    );

    // surfacedBy must be set when onLightData fires
    expect(lightDataSurfacedBy).toEqual(["mainuser"]);
  });

  it("returns empty results immediately when repos and trackedUsers are both empty", async () => {
    const octokit = makeOctokit(
      async () => { throw new Error("should not be called"); },
      async () => { throw new Error("should not be called"); }
    );

    const result = await fetchIssuesAndPullRequests(
      octokit as never, [], "mainuser", undefined, []
    );

    expect(result.issues).toEqual([]);
    expect(result.pullRequests).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(octokit.graphql).not.toHaveBeenCalled();
  });
});

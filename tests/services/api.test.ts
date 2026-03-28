import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchOrgs,
  fetchRepos,
  fetchIssues,
  fetchPullRequests,
  fetchWorkflowRuns,
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
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
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
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
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
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
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
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
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
});

// ── fetchIssues (GraphQL search) ─────────────────────────────────────────────

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

function makeGraphqlIssueResponse(nodes = [graphqlIssueNode], hasNextPage = false, issueCount?: number) {
  return {
    search: {
      issueCount: issueCount ?? nodes.length,
      pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor1" : null },
      nodes,
    },
    rateLimit: { remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() },
  };
}

describe("fetchIssues", () => {
  function makeIssueOctokit(graphqlImpl?: (query: string, variables?: unknown) => Promise<unknown>) {
    return makeOctokit(async () => ({ data: [], headers: {} }), graphqlImpl ?? (async () => makeGraphqlIssueResponse()));
  }

  it("returns issues from GraphQL search results", async () => {
    const octokit = makeIssueOctokit();
    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    expect(result.issues.length).toBe(1);
    expect(result.issues[0].id).toBe(1347);
    expect(result.errors).toEqual([]);
  });

  it("uses GraphQL search with involves qualifier", async () => {
    const octokit = makeIssueOctokit();
    await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    expect(octokit.graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ q: expect.stringContaining("involves:octocat") })
    );
    expect(octokit.graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ q: expect.stringContaining("is:issue") })
    );
  });

  it("includes repo qualifiers in GraphQL search query", async () => {
    const octokit = makeIssueOctokit();
    await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    expect(octokit.graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ q: expect.stringContaining("repo:octocat/Hello-World") })
    );
  });

  it("maps GraphQL fields to camelCase issue shape", async () => {
    const octokit = makeIssueOctokit();
    const { issues } = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    const issue = issues[0];
    expect(issue.id).toBe(1347); // databaseId → id
    expect(issue.htmlUrl).toBe("https://github.com/octocat/Hello-World/issues/1347"); // url → htmlUrl
    expect(issue.userLogin).toBe("octocat"); // author.login
    expect(issue.userAvatarUrl).toBe("https://github.com/images/error/octocat_happy.gif"); // author.avatarUrl
    expect(issue.repoFullName).toBe("octocat/Hello-World"); // repository.nameWithOwner
    expect(issue.comments).toBe(3); // comments.totalCount
    expect(issue.assigneeLogins).toEqual(["octocat"]);
    expect(issue.labels).toEqual([{ name: "bug", color: "d73a4a" }]);
  });

  it("returns empty result when repos is empty", async () => {
    const octokit = makeIssueOctokit();
    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [],
      "octocat"
    );

    expect(result.issues).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(octokit.graphql).not.toHaveBeenCalled();
  });

  it("batches repos into chunks of 50", async () => {
    const repos: RepoRef[] = Array.from({ length: 55 }, (_, i) => ({
      owner: "org",
      name: `repo-${i}`,
      fullName: `org/repo-${i}`,
    }));

    const octokit = makeIssueOctokit();
    await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      repos,
      "octocat"
    );

    // Should make 2 GraphQL calls (50 + 5 repos)
    expect(octokit.graphql).toHaveBeenCalledTimes(2);
  });

  it("deduplicates issues across batches by databaseId", async () => {
    const repos: RepoRef[] = Array.from({ length: 35 }, (_, i) => ({
      owner: "org",
      name: `repo-${i}`,
      fullName: `org/repo-${i}`,
    }));

    // Both batches return the same databaseId
    const octokit = makeIssueOctokit(async () => makeGraphqlIssueResponse([graphqlIssueNode]));
    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      repos,
      "octocat"
    );

    expect(result.issues.length).toBe(1);
  });

  it("paginates GraphQL search across multiple pages", async () => {
    let callCount = 0;
    const octokit = makeIssueOctokit(async (_query, variables) => {
      callCount++;
      if (callCount === 1) {
        // First page: has next page
        expect((variables as Record<string, unknown>).cursor).toBeNull();
        return makeGraphqlIssueResponse([{ ...graphqlIssueNode, databaseId: 1 }], true);
      }
      // Second page: last page
      expect((variables as Record<string, unknown>).cursor).toBe("cursor1");
      return makeGraphqlIssueResponse([{ ...graphqlIssueNode, databaseId: 2 }], false);
    });

    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    expect(octokit.graphql).toHaveBeenCalledTimes(2);
    expect(result.issues.length).toBe(2);
  });

  it("caps at 1000 items and warns via pushNotification", async () => {
    vi.mocked(pushNotification).mockClear();

    // Return 1000 items in first response with issueCount > 1000
    const manyNodes = Array.from({ length: 1000 }, (_, i) => ({ ...graphqlIssueNode, databaseId: i + 1 }));
    const octokit = makeIssueOctokit(async () => makeGraphqlIssueResponse(manyNodes, true, 1500));

    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // Stopped at 1000
    expect(result.issues.length).toBe(1000);
    // Only 1 graphql call (stopped before paginating)
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
    // Warning notification sent
    expect(pushNotification).toHaveBeenCalledWith(
      "search/issues",
      expect.stringContaining("capped at 1,000"),
      "warning"
    );
  });

  it("handles null nodes in GraphQL search results", async () => {
    const octokit = makeIssueOctokit(async () => ({
      search: {
        issueCount: 2,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [graphqlIssueNode, null, { ...graphqlIssueNode, databaseId: 999 }],
      },
      rateLimit: { remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() },
    }));

    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    expect(result.issues.length).toBe(2); // null filtered out
  });

  it("returns partial results and an error when second page throws mid-pagination", async () => {
    vi.mocked(pushNotification).mockClear();

    let callCount = 0;
    const octokit = makeIssueOctokit(async () => {
      callCount++;
      if (callCount === 1) {
        // First page succeeds with more pages available
        return makeGraphqlIssueResponse([{ ...graphqlIssueNode, databaseId: 1 }], true);
      }
      // Second page throws
      throw new Error("GraphQL rate limit exceeded");
    });

    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // Issues from the first page are returned
    expect(result.issues.length).toBe(1);
    expect(result.issues[0].id).toBe(1);

    // An ApiError is included in the result's errors array
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].message).toContain("GraphQL rate limit exceeded");
    expect(result.errors[0].repo).toBe("search-batch-1/1");

    // pushNotification is NOT called (no 1000-item cap was reached)
    expect(pushNotification).not.toHaveBeenCalled();
  });

  it("extracts partial data from GraphqlResponseError and stops pagination", async () => {
    vi.mocked(pushNotification).mockClear();

    // Simulate a GraphqlResponseError: has .data with valid nodes + errors
    const partialError = Object.assign(new Error("Some nodes failed to resolve"), {
      data: {
        search: {
          issueCount: 5,
          pageInfo: { hasNextPage: true, endCursor: "cursor-partial" },
          nodes: [{ ...graphqlIssueNode, databaseId: 42 }, null],
        },
        rateLimit: { remaining: 4990, resetAt: new Date(Date.now() + 3600000).toISOString() },
      },
    });
    const octokit = makeIssueOctokit(async () => {
      throw partialError;
    });

    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // Valid node from partial data is returned
    expect(result.issues.length).toBe(1);
    expect(result.issues[0].id).toBe(42);
    // Error is recorded
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].message).toContain("Some nodes failed to resolve");
    // Only 1 graphql call — did NOT try to paginate after partial error
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
  });

  it("catches unexpected response shapes without crashing", async () => {
    // Return a malformed response missing search.nodes — would TypeError without catch-all
    const octokit = makeIssueOctokit(async () => ({
      search: { issueCount: 0, pageInfo: null, nodes: null },
      rateLimit: null,
    }));

    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // Function returns gracefully with an error, not a thrown TypeError
    expect(result.issues).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].retryable).toBe(false);
  });

  it("rejects invalid userLogin with error instead of injecting into query", async () => {
    const octokit = makeIssueOctokit();
    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "bad user" // contains space — fails VALID_LOGIN
    );

    expect(result.issues).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].message).toContain("Invalid userLogin");
    expect(octokit.graphql).not.toHaveBeenCalled();
  });

  it("truncates to exactly 1000 when parallel chunks overshoot", async () => {
    vi.mocked(pushNotification).mockClear();

    // 55 repos → 2 chunks. Each chunk returns 600 items (total 1200, well over cap).
    const repos: RepoRef[] = Array.from({ length: 55 }, (_, i) => ({
      owner: "org",
      name: `repo-${i}`,
      fullName: `org/repo-${i}`,
    }));

    let callCount = 0;
    const octokit = makeIssueOctokit(async () => {
      callCount++;
      const batchStart = (callCount - 1) * 600;
      const nodes = Array.from({ length: 600 }, (_, i) => ({
        ...graphqlIssueNode,
        databaseId: batchStart + i + 1,
      }));
      return makeGraphqlIssueResponse(nodes, false, 600);
    });

    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      repos,
      "octocat"
    );

    // splice(1000) ensures exactly 1000 even with parallel overshoot
    expect(result.issues.length).toBe(1000);
    expect(pushNotification).toHaveBeenCalledWith(
      "search/issues",
      expect.stringContaining("capped at 1,000"),
      "warning"
    );
  });

  it("throws when octokit is null", async () => {
    await expect(fetchIssues(null, [testRepo], "octocat")).rejects.toThrow(
      "No GitHub client available"
    );
  });
});

// ── fetchPullRequests (GraphQL search) ───────────────────────────────────────

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

function makeGraphqlPRResponse(nodes = [graphqlPRNode], hasNextPage = false, issueCount?: number) {
  return {
    search: {
      issueCount: issueCount ?? nodes.length,
      pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor1" : null },
      nodes,
    },
    rateLimit: { remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() },
  };
}

describe("fetchPullRequests", () => {
  function makePROctokit(graphqlImpl?: (query: string, variables?: unknown) => Promise<unknown>) {
    return makeOctokit(
      async () => ({ data: [], headers: {} }),
      graphqlImpl ?? (async () => makeGraphqlPRResponse())
    );
  }

  it("uses GraphQL search with involves and review-requested qualifiers", async () => {
    const calls: string[] = [];
    const octokit = makePROctokit(async (_query, variables) => {
      calls.push((variables as Record<string, unknown>).q as string);
      return makeGraphqlPRResponse();
    });

    await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // 2 query types × 1 batch = 2 calls
    expect(calls.some((q) => q.includes("involves:octocat"))).toBe(true);
    expect(calls.some((q) => q.includes("review-requested:octocat"))).toBe(true);
  });

  it("maps GraphQL PR fields to camelCase shape", async () => {
    const octokit = makePROctokit();

    const { pullRequests } = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    const pr = pullRequests[0];
    expect(pr.id).toBe(42); // databaseId
    expect(pr.draft).toBe(false); // isDraft
    expect(pr.htmlUrl).toBe("https://github.com/octocat/Hello-World/pull/42"); // url
    expect(pr.headSha).toBe("abc123"); // headRefOid
    expect(pr.headRef).toBe("feature-branch"); // headRefName
    expect(pr.baseRef).toBe("main"); // baseRefName
    expect(pr.comments).toBe(3); // comments.totalCount
    expect(pr.reviewThreads).toBe(2); // reviewThreads.totalCount
    expect(pr.totalReviewCount).toBe(1); // latestReviews.totalCount
    expect(pr.additions).toBe(100);
    expect(pr.changedFiles).toBe(5);
    expect(pr.repoFullName).toBe("octocat/Hello-World");
  });

  it("maps statusCheckRollup states correctly", async () => {
    const states: Array<[string | null, string | null]> = [
      ["SUCCESS", "success"],
      ["FAILURE", "failure"],
      ["ERROR", "failure"],
      ["ACTION_REQUIRED", "failure"],
      ["PENDING", "pending"],
      ["EXPECTED", "pending"],
      ["QUEUED", "pending"],
      [null, null],
    ];

    for (const [rawState, expected] of states) {
      await clearCache();
      const node = {
        ...graphqlPRNode,
        databaseId: 100,
        commits: { nodes: [{ commit: { statusCheckRollup: rawState ? { state: rawState } : null } }] },
      } as typeof graphqlPRNode;
      const octokit = makePROctokit(async () => makeGraphqlPRResponse([node]));
      const { pullRequests } = await fetchPullRequests(
        octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
        [testRepo],
        "octocat"
      );
      expect(pullRequests[0].checkStatus).toBe(expected);
    }
  });

  it("merges reviewRequests and latestReviews into reviewerLogins with Set dedup", async () => {
    const nodeWithOverlap = {
      ...graphqlPRNode,
      databaseId: 200,
      reviewRequests: { nodes: [{ requestedReviewer: { login: "shared" } }] },
      latestReviews: { totalCount: 2, nodes: [{ author: { login: "shared" } }, { author: { login: "unique" } }] },
    };
    const octokit = makePROctokit(async () => makeGraphqlPRResponse([nodeWithOverlap]));

    const { pullRequests } = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // "shared" appears in both — should only appear once
    expect(pullRequests[0].reviewerLogins).toEqual(expect.arrayContaining(["shared", "unique"]));
    expect(pullRequests[0].reviewerLogins.filter((l) => l === "shared")).toHaveLength(1);
  });

  it("maps reviewDecision pass-through", async () => {
    for (const decision of ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", null] as const) {
      await clearCache();
      const node = { ...graphqlPRNode, databaseId: 300, reviewDecision: decision } as typeof graphqlPRNode;
      const octokit = makePROctokit(async () => makeGraphqlPRResponse([node]));
      const { pullRequests } = await fetchPullRequests(
        octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
        [testRepo],
        "octocat"
      );
      expect(pullRequests[0].reviewDecision).toBe(decision);
    }
  });

  it("deduplicates PRs from involves and review-requested by databaseId", async () => {
    // Both query types return the same PR node
    const octokit = makePROctokit(async () => makeGraphqlPRResponse([graphqlPRNode]));

    const { pullRequests } = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // Only 1 PR even though returned by both involves + review-requested queries
    expect(pullRequests.length).toBe(1);
  });

  it("detects fork PR and fires fallback query when checkStatus is null", async () => {
    const forkNode = {
      ...graphqlPRNode,
      databaseId: 500,
      // Head repo owner differs from base repo owner → fork
      headRepository: { owner: { login: "fork-owner" }, nameWithOwner: "fork-owner/Hello-World" },
      repository: { nameWithOwner: "octocat/Hello-World" },
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    } as unknown as typeof graphqlPRNode;

    let graphqlCallCount = 0;
    const octokit = makePROctokit(async () => {
      graphqlCallCount++;
      if (graphqlCallCount <= 2) {
        // Primary search queries
        return makeGraphqlPRResponse([forkNode]);
      }
      // Fork fallback query
      return {
        fork0: { object: { statusCheckRollup: { state: "SUCCESS" } } },
        rateLimit: { remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() },
      };
    });

    const { pullRequests } = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // Fork fallback was triggered
    expect(graphqlCallCount).toBeGreaterThan(2);
    // checkStatus populated from fork fallback
    expect(pullRequests[0].checkStatus).toBe("success");
  });

  it("handles deleted fork (null headRepository) gracefully — no fallback", async () => {
    const deletedForkNode = {
      ...graphqlPRNode,
      databaseId: 600,
      headRepository: null,
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    } as unknown as typeof graphqlPRNode;
    let graphqlCallCount = 0;
    const octokit = makePROctokit(async () => {
      graphqlCallCount++;
      return makeGraphqlPRResponse([deletedForkNode]);
    });

    const { pullRequests } = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // No extra graphql call for the fork fallback
    expect(graphqlCallCount).toBe(2); // 2 query types × 1 batch
    expect(pullRequests[0].checkStatus).toBeNull();
  });

  it("preserves PR when headRepository.nameWithOwner is malformed", async () => {
    const malformedNode = {
      ...graphqlPRNode,
      databaseId: 700,
      headRepository: {
        owner: { login: "fork-owner" },
        nameWithOwner: "no-slash-here", // malformed — missing "/"
      },
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    } as unknown as typeof graphqlPRNode;
    const octokit = makePROctokit(async () => makeGraphqlPRResponse([malformedNode]));

    const { pullRequests } = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // PR is NOT silently dropped — it's returned with null checkStatus
    expect(pullRequests.length).toBe(1);
    expect(pullRequests[0].id).toBe(700);
    expect(pullRequests[0].checkStatus).toBeNull();
  });

  it("stops pagination when hasNextPage is true but endCursor is null", async () => {
    let callCount = 0;
    const octokit = makePROctokit(async () => {
      callCount++;
      return {
        search: {
          issueCount: 100,
          pageInfo: { hasNextPage: true, endCursor: null }, // degenerate response
          nodes: [{ ...graphqlPRNode, databaseId: callCount }],
        },
        rateLimit: { remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() },
      };
    });

    const { pullRequests } = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // Should NOT loop infinitely — breaks after first page per query type
    expect(pullRequests.length).toBeGreaterThan(0);
    // 2 query types × 1 page each (stopped by null endCursor) = 2 calls
    expect(callCount).toBe(2);
  });

  it("surfaces pushNotification when fork fallback query fails", async () => {
    vi.mocked(pushNotification).mockClear();

    // PR with fork head that differs from base owner
    const forkNode = {
      ...graphqlPRNode,
      databaseId: 800,
      headRepository: {
        owner: { login: "fork-user" },
        nameWithOwner: "fork-user/some-repo",
      },
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    } as unknown as typeof graphqlPRNode;

    let callCount = 0;
    const octokit = makePROctokit(async () => {
      callCount++;
      if (callCount <= 2) {
        // First 2 calls: involves + review-requested search queries
        return makeGraphqlPRResponse([forkNode]);
      }
      // 3rd call: fork fallback query — throw to simulate failure
      throw new Error("Fork repo not accessible");
    });

    const { pullRequests } = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    expect(pullRequests.length).toBe(1);
    expect(pullRequests[0].checkStatus).toBeNull(); // fallback failed, stays null
    expect(pushNotification).toHaveBeenCalledWith(
      "graphql",
      expect.stringContaining("Fork PR check status unavailable"),
      "warning"
    );
  });

  it("recovers partial data from fork fallback GraphqlResponseError", async () => {
    vi.mocked(pushNotification).mockClear();

    // Two fork PRs: one resolves in partial data, one doesn't
    const forkNodes = [
      {
        ...graphqlPRNode, databaseId: 901,
        headRepository: { owner: { login: "fork-a" }, nameWithOwner: "fork-a/repo" },
        repository: { nameWithOwner: "octocat/Hello-World" },
        commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
      },
      {
        ...graphqlPRNode, databaseId: 902,
        headRepository: { owner: { login: "fork-b" }, nameWithOwner: "fork-b/repo" },
        repository: { nameWithOwner: "octocat/Hello-World" },
        commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
      },
    ] as unknown as (typeof graphqlPRNode)[];

    let graphqlCallCount = 0;
    const octokit = makePROctokit(async () => {
      graphqlCallCount++;
      if (graphqlCallCount <= 2) {
        return makeGraphqlPRResponse(forkNodes);
      }
      // Fork fallback: GraphqlResponseError with partial data — fork0 resolves, fork1 doesn't
      throw Object.assign(new Error("Partial fork resolution failure"), {
        data: {
          fork0: { object: { statusCheckRollup: { state: "SUCCESS" } } },
          // fork1 is missing — that fork repo was deleted/inaccessible
          rateLimit: { remaining: 4990, resetAt: new Date(Date.now() + 3600000).toISOString() },
        },
      });
    });

    const { pullRequests } = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    const pr901 = pullRequests.find((pr) => pr.id === 901);
    const pr902 = pullRequests.find((pr) => pr.id === 902);
    // fork0 resolved from partial data
    expect(pr901?.checkStatus).toBe("success");
    // fork1 not in partial data — stays null
    expect(pr902?.checkStatus).toBeNull();
    // Notification still fires for the partial failure
    expect(pushNotification).toHaveBeenCalledWith(
      "graphql",
      expect.stringContaining("Fork PR check status unavailable"),
      "warning"
    );
  });

  it("returns partial results and an error when second page throws mid-pagination", async () => {
    vi.mocked(pushNotification).mockClear();

    // Track calls per query type: involves query fires first, then review-requested
    // Each query type paginates independently. We want the involves query to:
    //   page 1: success with hasNextPage=true
    //   page 2: throw an error
    // The review-requested query should succeed normally.
    let involvesCallCount = 0;
    const octokit = makePROctokit(async (_query, variables) => {
      const q = (variables as Record<string, unknown>).q as string;
      if (q.includes("involves:")) {
        involvesCallCount++;
        if (involvesCallCount === 1) {
          // First page succeeds with more pages available
          return makeGraphqlPRResponse([{ ...graphqlPRNode, databaseId: 101 }], true);
        }
        // Second page throws
        throw new Error("GraphQL connection error");
      }
      // review-requested query returns empty — avoid duplicate databaseId confusion
      return makeGraphqlPRResponse([]);
    });

    const result = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // PR from the first page is returned
    expect(result.pullRequests.some((pr) => pr.id === 101)).toBe(true);

    // An ApiError is included in the result's errors array
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].message).toContain("GraphQL connection error");
    expect(result.errors[0].repo).toBe("pr-search-batch-1/1");

    // pushNotification is NOT called (no 1000-item cap was reached)
    expect(pushNotification).not.toHaveBeenCalled();
  });

  it("extracts partial PR data from GraphqlResponseError and stops pagination", async () => {
    vi.mocked(pushNotification).mockClear();

    const partialError = Object.assign(new Error("Partial node resolution failure"), {
      data: {
        search: {
          issueCount: 3,
          pageInfo: { hasNextPage: true, endCursor: "cursor-partial" },
          nodes: [{ ...graphqlPRNode, databaseId: 77 }],
        },
        rateLimit: { remaining: 4990, resetAt: new Date(Date.now() + 3600000).toISOString() },
      },
    });
    const octokit = makePROctokit(async (_query, variables) => {
      const q = (variables as Record<string, unknown>).q as string;
      if (q.includes("involves:")) throw partialError;
      return makeGraphqlPRResponse([]);
    });

    const result = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    expect(result.pullRequests.length).toBe(1);
    expect(result.pullRequests[0].id).toBe(77);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].message).toContain("Partial node resolution failure");
    // involves query: 1 call (threw partial, stopped). review-requested: 1 call = 2 total
    expect(octokit.graphql).toHaveBeenCalledTimes(2);
  });

  it("catches unexpected PR response shapes without crashing", async () => {
    const octokit = makePROctokit(async () => ({
      search: { issueCount: 0, pageInfo: null, nodes: null },
      rateLimit: null,
    }));

    const result = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    expect(result.pullRequests).toEqual([]);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0].retryable).toBe(false);
  });

  it("caps at 1000 PRs and warns via pushNotification", async () => {
    vi.mocked(pushNotification).mockClear();

    const manyNodes = Array.from({ length: 1000 }, (_, i) => ({ ...graphqlPRNode, databaseId: i + 1 }));
    const octokit = makePROctokit(async (_query, variables) => {
      const q = (variables as Record<string, unknown>).q as string;
      if (q.includes("involves:")) {
        return makeGraphqlPRResponse(manyNodes, true, 1500);
      }
      return makeGraphqlPRResponse([]);
    });

    const result = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    expect(result.pullRequests.length).toBe(1000);
    expect(pushNotification).toHaveBeenCalledWith(
      "search/prs",
      expect.stringContaining("capped at 1,000"),
      "warning"
    );
  });

  it("fork fallback handles >50 fork PRs across multiple batches", async () => {
    // Create 55 fork PRs — should split into 50 + 5 fork fallback batches
    const forkNodes = Array.from({ length: 55 }, (_, i) => ({
      ...graphqlPRNode,
      databaseId: 2000 + i,
      headRepository: { owner: { login: "fork-owner" }, nameWithOwner: `fork-owner/repo-${i}` },
      repository: { nameWithOwner: "octocat/Hello-World" },
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    })) as unknown as (typeof graphqlPRNode)[];

    let graphqlCallCount = 0;
    const octokit = makePROctokit(async (_query, variables) => {
      graphqlCallCount++;
      const q = (variables as Record<string, unknown>).q as string | undefined;
      if (q) {
        // Primary search queries return all 55 fork PRs (involves only)
        if (q.includes("involves:")) return makeGraphqlPRResponse(forkNodes);
        return makeGraphqlPRResponse([]);
      }
      // Fork fallback queries
      const response: Record<string, unknown> = {
        rateLimit: { remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() },
      };
      const indices = Object.keys(variables as Record<string, unknown>)
        .filter((k) => k.startsWith("owner"))
        .map((k) => parseInt(k.replace("owner", ""), 10));
      for (const i of indices) {
        response[`fork${i}`] = { object: { statusCheckRollup: { state: "SUCCESS" } } };
      }
      return response;
    });

    const { pullRequests } = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // All 55 PRs should have check status resolved from fork fallback
    const forkPRs = pullRequests.filter((pr) => pr.id >= 2000 && pr.id < 2055);
    expect(forkPRs.length).toBe(55);
    for (const pr of forkPRs) {
      expect(pr.checkStatus).toBe("success");
    }
  });

  it("returns empty result when repos is empty", async () => {
    const octokit = makePROctokit();
    const result = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [],
      "octocat"
    );
    expect(result.pullRequests).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(octokit.graphql).not.toHaveBeenCalled();
  });

  it("throws when octokit is null", async () => {
    await expect(
      fetchPullRequests(null, [testRepo], "octocat")
    ).rejects.toThrow("No GitHub client available");
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
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
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
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
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
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
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
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
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
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
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
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
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
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
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
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
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
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
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
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      5,
      10
    );

    // First run in results should be from the workflow with the most recent updatedAt
    // Workflow 1001 latestAt=2024-01-15T10:05:00Z > Workflow 1002 latestAt=2024-01-15T09:25:00Z
    expect(workflowRuns[0].workflowId).toBe(1001);
  });
});


// ── qa-10: Empty userLogin short-circuit ──────────────────────────────────────

describe("empty userLogin short-circuit", () => {
  it("fetchIssues returns empty result and makes no API calls when userLogin is empty string", async () => {
    const octokit = {
      request: vi.fn(),
      paginate: { iterator: vi.fn() },
    };

    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "" // empty userLogin
    );

    expect(result.issues).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(octokit.request).not.toHaveBeenCalled();
  });

  it("fetchPullRequests returns empty result and makes no API calls when userLogin is empty string", async () => {
    const request = vi.fn();
    const graphql = vi.fn();
    const octokit = { request, graphql, paginate: { iterator: vi.fn() } };

    const result = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "" // empty userLogin
    );

    expect(result.pullRequests).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expect(graphql).not.toHaveBeenCalled();
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
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
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
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      5,
      3
    );

    // Only 1 page request should be made
    expect(requestCount).toBe(1);
  });
});

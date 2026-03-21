import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchOrgs,
  fetchRepos,
  fetchIssues,
  fetchPullRequests,
  fetchWorkflowRuns,
  aggregateErrors,
  type RepoRef,
} from "../../src/app/services/api";
import { clearCache } from "../../src/app/stores/cache";

import orgsFixture from "../fixtures/github-orgs.json";
import reposFixture from "../fixtures/github-repos.json";
import searchIssuesFixture from "../fixtures/github-search-issues.json";
import searchPrsFixture from "../fixtures/github-search-prs.json";
import prsFixture from "../fixtures/github-prs.json";
import runsFixture from "../fixtures/github-runs.json";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeOctokit(requestImpl: (route: string, params?: unknown) => Promise<unknown>) {
  return {
    request: vi.fn(requestImpl),
    paginate: {
      iterator: vi.fn((route: string, _params?: unknown) => {
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

// ── fetchIssues (Search API) ─────────────────────────────────────────────────

describe("fetchIssues", () => {
  function makeSearchOctokit(searchData?: unknown) {
    return {
      request: vi.fn(async (route: string) => {
        if (route === "GET /search/issues") {
          return {
            data: searchData ?? searchIssuesFixture,
            headers: {},
          };
        }
        return { data: { total_count: 0, incomplete_results: false, items: [] }, headers: {} };
      }),
      paginate: { iterator: vi.fn() },
    };
  }

  it("returns issues from search results", async () => {
    const octokit = makeSearchOctokit();
    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    expect(result.issues.length).toBe(searchIssuesFixture.items.length);
    expect(result.issues[0].id).toBe(searchIssuesFixture.items[0].id);
    expect(result.errors).toEqual([]);
  });

  it("uses the Search API with involves qualifier", async () => {
    const octokit = makeSearchOctokit();
    await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    expect(octokit.request).toHaveBeenCalledWith(
      "GET /search/issues",
      expect.objectContaining({
        q: expect.stringContaining("involves:octocat"),
      })
    );
    expect(octokit.request).toHaveBeenCalledWith(
      "GET /search/issues",
      expect.objectContaining({
        q: expect.stringContaining("is:issue"),
      })
    );
  });

  it("includes repo qualifiers in search query", async () => {
    const octokit = makeSearchOctokit();
    await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    expect(octokit.request).toHaveBeenCalledWith(
      "GET /search/issues",
      expect.objectContaining({
        q: expect.stringContaining("repo:octocat/Hello-World"),
      })
    );
  });

  it("filters out items with pull_request field", async () => {
    const withPR = {
      total_count: 2,
      incomplete_results: false,
      items: [
        searchIssuesFixture.items[0],
        { ...searchIssuesFixture.items[1], pull_request: { url: "https://..." } },
      ],
    };
    const octokit = makeSearchOctokit(withPR);

    const { issues } = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    expect(issues.length).toBe(1);
    expect(issues[0].id).toBe(searchIssuesFixture.items[0].id);
  });

  it("maps search result fields to camelCase issue shape", async () => {
    const octokit = makeSearchOctokit();
    const { issues } = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    const issue = issues[0];
    expect(issue.htmlUrl).toBeDefined();
    expect(issue.createdAt).toBeDefined();
    expect(issue.updatedAt).toBeDefined();
    expect(issue.userLogin).toBeDefined();
    expect(issue.userAvatarUrl).toBeDefined();
    expect(issue.assigneeLogins).toBeDefined();
    expect(issue.repoFullName).toBe("octocat/Hello-World");
  });

  it("returns empty result when repos is empty", async () => {
    const octokit = makeSearchOctokit();
    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [],
      "octocat"
    );

    expect(result.issues).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(octokit.request).not.toHaveBeenCalled();
  });

  it("batches repos into chunks of 30", async () => {
    // Create 35 repos to force 2 batches
    const repos: RepoRef[] = Array.from({ length: 35 }, (_, i) => ({
      owner: "org",
      name: `repo-${i}`,
      fullName: `org/repo-${i}`,
    }));

    const octokit = makeSearchOctokit();
    await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      repos,
      "octocat"
    );

    // Should make 2 search calls (30 + 5)
    expect(octokit.request).toHaveBeenCalledTimes(2);
  });

  it("deduplicates issues across batches", async () => {
    // Same item returned by both batch calls
    const sameItem = searchIssuesFixture.items[0];
    const searchData = {
      total_count: 1,
      incomplete_results: false,
      items: [sameItem],
    };

    const repos: RepoRef[] = Array.from({ length: 35 }, (_, i) => ({
      owner: "org",
      name: `repo-${i}`,
      fullName: `org/repo-${i}`,
    }));

    const octokit = makeSearchOctokit(searchData);
    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      repos,
      "octocat"
    );

    // Should deduplicate: only 1 issue even though returned by 2 batches
    expect(result.issues.length).toBe(1);
  });

  it("throws when octokit is null", async () => {
    await expect(fetchIssues(null, [testRepo], "octocat")).rejects.toThrow(
      "No GitHub client available"
    );
  });
});

// ── fetchPullRequests (Search API + individual PR detail) ────────────────────

describe("fetchPullRequests", () => {
  function makeOctokitForPRs() {
    const request = vi.fn(async (route: string) => {
      if (route === "GET /search/issues") {
        return { data: searchPrsFixture, headers: {} };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        return { data: prsFixture[0], headers: { etag: "etag-pr-detail" } };
      }
      return { data: { total_count: 0, incomplete_results: false, items: [] }, headers: {} };
    });
    const graphql = vi.fn(async () => ({
      pr0: {
        object: {
          statusCheckRollup: { state: "SUCCESS" },
        },
      },
    }));
    return { request, graphql, paginate: { iterator: vi.fn() } };
  }

  it("uses search API with involves and review-requested qualifiers", async () => {
    const octokit = makeOctokitForPRs();

    await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // Should make 2 search calls: involves + review-requested
    const searchCalls = octokit.request.mock.calls.filter(
      (c) => c[0] === "GET /search/issues"
    );
    expect(searchCalls.length).toBe(2);

    const queries = searchCalls.map((c) => ((c as unknown[])[1] as { q: string }).q);
    expect(queries.some((q) => q.includes("involves:octocat"))).toBe(true);
    expect(queries.some((q) => q.includes("review-requested:octocat"))).toBe(true);
  });

  it("fetches full PR details for each search result", async () => {
    const octokit = makeOctokitForPRs();

    await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    const prDetailCalls = octokit.request.mock.calls.filter(
      (c) => c[0] === "GET /repos/{owner}/{repo}/pulls/{pull_number}"
    );
    expect(prDetailCalls.length).toBe(1); // 1 unique PR in fixture
  });

  it("fetches check status via GraphQL batch call", async () => {
    const octokit = makeOctokitForPRs();

    const { pullRequests } = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // Should use GraphQL for check status, not REST
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
    const graphqlQuery = (octokit.graphql.mock.calls as unknown[][])[0][0] as string;
    expect(graphqlQuery).toContain("statusCheckRollup");

    // No REST check status calls should be made
    const restCheckCalls = octokit.request.mock.calls.filter(
      (c) =>
        c[0] === "GET /repos/{owner}/{repo}/commits/{ref}/status" ||
        c[0] === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs"
    );
    expect(restCheckCalls.length).toBe(0);

    // Check status should be mapped from GraphQL response
    for (const pr of pullRequests) {
      expect(["success", "failure", "pending", null]).toContain(pr.checkStatus);
    }
  });

  it("maps GraphQL statusCheckRollup states correctly", async () => {
    // Test FAILURE state
    const octokitFailure = makeOctokitForPRs();
    (octokitFailure as Record<string, unknown>).graphql = vi.fn(async () => ({
      pr0: { object: { statusCheckRollup: { state: "FAILURE" } } },
    }));
    const failResult = await fetchPullRequests(
      octokitFailure as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );
    expect(failResult.pullRequests[0].checkStatus).toBe("failure");

    await clearCache();

    // Test PENDING state
    const octokitPending = makeOctokitForPRs();
    (octokitPending as Record<string, unknown>).graphql = vi.fn(async () => ({
      pr0: { object: { statusCheckRollup: { state: "PENDING" } } },
    }));
    const pendResult = await fetchPullRequests(
      octokitPending as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );
    expect(pendResult.pullRequests[0].checkStatus).toBe("pending");

    await clearCache();

    // Test null (no checks)
    const octokitNull = makeOctokitForPRs();
    (octokitNull as Record<string, unknown>).graphql = vi.fn(async () => ({
      pr0: { object: null },
    }));
    const nullResult = await fetchPullRequests(
      octokitNull as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );
    expect(nullResult.pullRequests[0].checkStatus).toBeNull();
  });

  it("falls back to null check status on GraphQL error", async () => {
    const octokit = makeOctokitForPRs();
    (octokit as Record<string, unknown>).graphql = vi.fn(async () => {
      throw new Error("GraphQL error");
    });

    const { pullRequests } = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // Should still return PRs, just with null check status
    expect(pullRequests.length).toBe(1);
    expect(pullRequests[0].checkStatus).toBeNull();
  });

  it("maps PR detail fields to camelCase shape", async () => {
    const octokit = makeOctokitForPRs();

    const { pullRequests } = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    const pr = pullRequests[0];
    expect(pr).toMatchObject({
      id: expect.any(Number),
      number: expect.any(Number),
      title: expect.any(String),
      state: expect.any(String),
      draft: expect.any(Boolean),
      htmlUrl: expect.any(String),
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      userLogin: expect.any(String),
      headSha: expect.any(String),
      headRef: expect.any(String),
      baseRef: expect.any(String),
      repoFullName: expect.any(String),
    });
  });

  it("deduplicates PRs found by both involves and review-requested", async () => {
    // Both search queries return the same PR
    const octokit = makeOctokitForPRs();

    const { pullRequests } = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // Only 1 PR despite being found by potentially both search queries
    expect(pullRequests.length).toBe(1);
  });

  it("returns empty result when repos is empty", async () => {
    const octokit = makeOctokitForPRs();
    const result = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [],
      "octocat"
    );
    expect(result.pullRequests).toEqual([]);
    expect(result.errors).toEqual([]);
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
        per_page: 100,
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

  it("throws when octokit is null", async () => {
    await expect(
      fetchWorkflowRuns(null, [testRepo], 5, 3)
    ).rejects.toThrow("No GitHub client available");
  });
});

// ── aggregateErrors ───────────────────────────────────────────────────────────

describe("aggregateErrors", () => {
  it("returns empty array when all results are fulfilled", () => {
    const results: [PromiseSettledResult<unknown>, string][] = [
      [{ status: "fulfilled", value: [] }, "octocat/Hello-World"],
      [{ status: "fulfilled", value: [] }, "acme-corp/acme-api"],
    ];
    expect(aggregateErrors(results)).toEqual([]);
  });

  it("classifies 401 as non-retryable auth error", () => {
    const err = Object.assign(new Error("Unauthorized"), { status: 401 });
    const results: [PromiseSettledResult<unknown>, string][] = [
      [{ status: "rejected", reason: err }, "octocat/Hello-World"],
    ];
    const errors = aggregateErrors(results);
    expect(errors[0].statusCode).toBe(401);
    expect(errors[0].retryable).toBe(false);
    expect(errors[0].repo).toBe("octocat/Hello-World");
  });

  it("classifies 403 without rate-limit header as non-retryable", () => {
    const err = Object.assign(new Error("Forbidden"), { status: 403, headers: {} });
    const results: [PromiseSettledResult<unknown>, string][] = [
      [{ status: "rejected", reason: err }, "acme-corp/acme-api"],
    ];
    const errors = aggregateErrors(results);
    expect(errors[0].statusCode).toBe(403);
    expect(errors[0].retryable).toBe(false);
  });

  it("classifies 403 with x-ratelimit-remaining=0 as retryable", () => {
    const err = Object.assign(new Error("Rate limited"), {
      status: 403,
      headers: { "x-ratelimit-remaining": "0" },
    });
    const results: [PromiseSettledResult<unknown>, string][] = [
      [{ status: "rejected", reason: err }, "octocat/Hello-World"],
    ];
    const errors = aggregateErrors(results);
    expect(errors[0].statusCode).toBe(403);
    expect(errors[0].retryable).toBe(true);
  });

  it("classifies 404 as non-retryable", () => {
    const err = Object.assign(new Error("Not Found"), { status: 404 });
    const results: [PromiseSettledResult<unknown>, string][] = [
      [{ status: "rejected", reason: err }, "octocat/missing-repo"],
    ];
    const errors = aggregateErrors(results);
    expect(errors[0].statusCode).toBe(404);
    expect(errors[0].retryable).toBe(false);
  });

  it("classifies 5xx as retryable", () => {
    const err = Object.assign(new Error("Internal Server Error"), { status: 500 });
    const results: [PromiseSettledResult<unknown>, string][] = [
      [{ status: "rejected", reason: err }, "octocat/Hello-World"],
    ];
    const errors = aggregateErrors(results);
    expect(errors[0].statusCode).toBe(500);
    expect(errors[0].retryable).toBe(true);
  });

  it("classifies network errors (no status) as retryable", () => {
    const err = new Error("fetch failed");
    const results: [PromiseSettledResult<unknown>, string][] = [
      [{ status: "rejected", reason: err }, "octocat/Hello-World"],
    ];
    const errors = aggregateErrors(results);
    expect(errors[0].statusCode).toBeNull();
    expect(errors[0].retryable).toBe(true);
  });

  it("handles mixed fulfilled and rejected results", () => {
    const err = Object.assign(new Error("Server Error"), { status: 503 });
    const results: [PromiseSettledResult<unknown>, string][] = [
      [{ status: "fulfilled", value: [] }, "octocat/Hello-World"],
      [{ status: "rejected", reason: err }, "acme-corp/acme-api"],
    ];
    const errors = aggregateErrors(results);
    expect(errors.length).toBe(1);
    expect(errors[0].repo).toBe("acme-corp/acme-api");
    expect(errors[0].retryable).toBe(true);
  });
});

// ── searchAllPages pagination ─────────────────────────────────────────────────

describe("searchAllPages (via fetchIssues)", () => {
  // Build a search octokit whose response depends on the `page` param
  function makePaginatingOctokit(totalCount: number, pageOneItems: number, pageTwoItems: number) {
    let callCount = 0;
    return {
      request: vi.fn(async (_route: string, params?: Record<string, unknown>) => {
        callCount++;
        const page = (params?.page as number) ?? 1;
        const items = Array.from({ length: page === 1 ? pageOneItems : pageTwoItems }, (_, i) => ({
          id: (page - 1) * 100 + i + 1,
          number: (page - 1) * 100 + i + 1,
          title: `Issue ${(page - 1) * 100 + i + 1}`,
          state: "open",
          html_url: `https://github.com/org/repo/issues/${(page - 1) * 100 + i + 1}`,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
          user: { login: "octocat", avatar_url: "https://github.com/images/error/octocat_happy.gif" },
          labels: [],
          assignees: [],
          repository: { full_name: "org/repo" },
        }));
        return {
          data: {
            total_count: totalCount,
            incomplete_results: false,
            items,
          },
          headers: {},
        };
      }),
      paginate: { iterator: vi.fn() },
    };
  }

  it("fetches both pages when total_count > 100 items", async () => {
    // total_count: 150, page 1 returns 100 items, page 2 returns 50
    const octokit = makePaginatingOctokit(150, 100, 50);
    const repos: RepoRef[] = [{ owner: "org", name: "repo", fullName: "org/repo" }];

    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      repos,
      "octocat"
    );

    // All 150 items should be returned (100 + 50)
    expect(result.issues.length).toBe(150);
    // Two pages should have been fetched
    const searchCalls = octokit.request.mock.calls.filter(
      (c) => c[0] === "GET /search/issues"
    );
    expect(searchCalls.length).toBe(2);
  });

  it("caps at 1000 items and warns when total_count > 1000", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Return 100 items per page, total_count = 2000
    let callCount = 0;
    const octokit = {
      request: vi.fn(async (_route: string) => {
        callCount++;
        const items = Array.from({ length: 100 }, (_, i) => ({
          id: (callCount - 1) * 100 + i + 1,
          number: (callCount - 1) * 100 + i + 1,
          title: `Issue ${(callCount - 1) * 100 + i + 1}`,
          state: "open",
          html_url: "https://github.com/org/repo/issues/1",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
          user: { login: "octocat", avatar_url: "https://github.com/images/error/octocat_happy.gif" },
          labels: [],
          assignees: [],
          repository: { full_name: "org/repo" },
        }));
        return {
          data: { total_count: 2000, incomplete_results: false, items },
          headers: {},
        };
      }),
      paginate: { iterator: vi.fn() },
    };

    const repos: RepoRef[] = [{ owner: "org", name: "repo", fullName: "org/repo" }];
    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      repos,
      "octocat"
    );

    // Should be capped at 1000 items (10 pages × 100)
    expect(result.issues.length).toBe(1000);
    // Should warn about the cap
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("capped at 1000")
    );

    warnSpy.mockRestore();
  });

  it("warns on incomplete_results: true", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const octokit = {
      request: vi.fn(async () => ({
        data: {
          total_count: 2,
          incomplete_results: true,
          items: [searchIssuesFixture.items[0]],
        },
        headers: {},
      })),
      paginate: { iterator: vi.fn() },
    };

    const repos: RepoRef[] = [{ owner: "octocat", name: "Hello-World", fullName: "octocat/Hello-World" }];
    await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      repos,
      "octocat"
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("incomplete")
    );

    warnSpy.mockRestore();
  });
});

// ── GraphQL ERROR and EXPECTED state mapping ──────────────────────────────────

describe("batchFetchCheckStatuses state mapping (via fetchPullRequests)", () => {
  function makeOctokitWithGraphQL(graphqlResponse: Record<string, unknown>) {
    return {
      request: vi.fn(async (route: string) => {
        if (route === "GET /search/issues") {
          return { data: searchPrsFixture, headers: {} };
        }
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
          return { data: prsFixture[0], headers: { etag: "etag-pr-detail" } };
        }
        return { data: { total_count: 0, incomplete_results: false, items: [] }, headers: {} };
      }),
      graphql: vi.fn(async () => graphqlResponse),
      paginate: { iterator: vi.fn() },
    };
  }

  it('maps state "ERROR" to "failure"', async () => {
    const octokit = makeOctokitWithGraphQL({
      pr0: { object: { statusCheckRollup: { state: "ERROR" } } },
    });

    const { pullRequests } = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    expect(pullRequests[0].checkStatus).toBe("failure");
  });

  it('maps state "EXPECTED" to "pending"', async () => {
    await clearCache();
    const octokit = makeOctokitWithGraphQL({
      pr0: { object: { statusCheckRollup: { state: "EXPECTED" } } },
    });

    const { pullRequests } = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    expect(pullRequests[0].checkStatus).toBe("pending");
  });

  it("maps statusCheckRollup: null (object exists but no rollup) to null", async () => {
    await clearCache();
    const octokit = makeOctokitWithGraphQL({
      pr0: { object: { statusCheckRollup: null } },
    });

    const { pullRequests } = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    expect(pullRequests[0].checkStatus).toBeNull();
  });
});

// ── Partial batch failure ─────────────────────────────────────────────────────

describe("batchedSearch partial batch failure (via fetchIssues)", () => {
  it("returns items from successful chunks and errors from failed chunks", async () => {
    // 35 repos → 2 chunks (30 + 5). First chunk rejects, second succeeds.
    let callCount = 0;
    const octokit = {
      request: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          throw Object.assign(new Error("search timeout"), { status: 503 });
        }
        return {
          data: {
            total_count: 1,
            incomplete_results: false,
            items: [searchIssuesFixture.items[0]],
          },
          headers: {},
        };
      }),
      paginate: { iterator: vi.fn() },
    };

    const repos: RepoRef[] = Array.from({ length: 35 }, (_, i) => ({
      owner: "org",
      name: `repo-${i}`,
      fullName: `org/repo-${i}`,
    }));

    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      repos,
      "octocat"
    );

    // Items from the successful chunk (chunk 2) should be present
    expect(result.issues.length).toBeGreaterThan(0);
    // Error from the failed chunk (chunk 1) should be reported
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].repo).toContain("search-batch-1/2");
    // Total items less than if both succeeded
    expect(result.issues.length).toBeLessThan(35);
  });
});

// ── GraphQL batch boundary (51 PRs → 2 chunks) ───────────────────────────────

describe("batchFetchCheckStatuses with 51 PRs (2 GraphQL chunks)", () => {
  it("calls GraphQL twice and maps all 51 results correctly", async () => {
    // Build 51 unique search items (as PRs)
    const prSearchItems = Array.from({ length: 51 }, (_, i) => ({
      id: 2000 + i,
      number: 100 + i,
      title: `PR ${i}`,
      state: "open",
      html_url: `https://github.com/octocat/Hello-World/pull/${100 + i}`,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      user: { login: "octocat", avatar_url: "https://github.com/images/error/octocat_happy.gif" },
      labels: [],
      assignees: [],
      repository: { full_name: "octocat/Hello-World" },
      pull_request: { url: `https://api.github.com/repos/octocat/Hello-World/pulls/${100 + i}` },
    }));

    const prDetail = {
      ...prsFixture[0],
    };

    let graphqlCallCount = 0;

    const octokit = {
      request: vi.fn(async (route: string, params?: Record<string, unknown>) => {
        if (route === "GET /search/issues") {
          return {
            data: {
              total_count: 51,
              incomplete_results: false,
              items: prSearchItems,
            },
            headers: {},
          };
        }
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
          const num = (params?.pull_number as number) ?? 100;
          return {
            data: {
              ...prDetail,
              id: 2000 + (num - 100),
              number: num,
              head: {
                ...prDetail.head,
                sha: `sha-${num}`,
              },
            },
            headers: { etag: `etag-pr-${num}` },
          };
        }
        return { data: { total_count: 0, incomplete_results: false, items: [] }, headers: {} };
      }),
      graphql: vi.fn(async (_query: string, variables: Record<string, unknown>) => {
        graphqlCallCount++;
        // Build a response with all prN keys present in this chunk
        const response: Record<string, unknown> = {};
        // Count how many prN aliases are in variables
        const indices = Object.keys(variables)
          .filter((k) => k.startsWith("owner"))
          .map((k) => parseInt(k.replace("owner", ""), 10));
        for (const i of indices) {
          response[`pr${i}`] = { object: { statusCheckRollup: { state: "SUCCESS" } } };
        }
        return response;
      }),
      paginate: { iterator: vi.fn() },
    };

    const { pullRequests } = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // GraphQL should have been called twice (50 + 1)
    expect(graphqlCallCount).toBe(2);
    // All 51 PRs should be returned
    expect(pullRequests.length).toBe(51);
    // All should have success check status
    for (const pr of pullRequests) {
      expect(pr.checkStatus).toBe("success");
    }
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

// ── Query-aware search mock verification ──────────────────────────────────────

describe("search query qualifiers", () => {
  it("fetchIssues sends is:issue qualifier (not is:pr)", async () => {
    const octokit = {
      request: vi.fn(async (route: string, params?: Record<string, unknown>) => {
        if (route === "GET /search/issues") {
          const q = (params?.q as string) ?? "";
          // Return matching items only for issue queries so we can verify
          return {
            data: {
              total_count: q.includes("is:issue") ? 1 : 0,
              incomplete_results: false,
              items: q.includes("is:issue") ? [searchIssuesFixture.items[0]] : [],
            },
            headers: {},
          };
        }
        return { data: { total_count: 0, incomplete_results: false, items: [] }, headers: {} };
      }),
      paginate: { iterator: vi.fn() },
    };

    await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    const calls = octokit.request.mock.calls.filter((c) => c[0] === "GET /search/issues");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const q = ((call as unknown[])[1] as { q: string }).q;
      expect(q).toContain("is:issue");
      expect(q).not.toContain("is:pr");
      expect(q).toContain("repo:octocat/Hello-World");
    }
  });

  it("fetchPullRequests sends is:pr qualifier (not is:issue)", async () => {
    const octokit = {
      request: vi.fn(async (route: string) => {
        if (route === "GET /search/issues") {
          return { data: searchPrsFixture, headers: {} };
        }
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
          return { data: prsFixture[0], headers: { etag: "etag-pr-detail" } };
        }
        return { data: { total_count: 0, incomplete_results: false, items: [] }, headers: {} };
      }),
      graphql: vi.fn(async () => ({
        pr0: { object: { statusCheckRollup: { state: "SUCCESS" } } },
      })),
      paginate: { iterator: vi.fn() },
    };

    await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    const searchCalls = octokit.request.mock.calls.filter(
      (c) => c[0] === "GET /search/issues"
    );
    expect(searchCalls.length).toBe(2);
    for (const call of searchCalls) {
      const q = ((call as unknown[])[1] as { q: string }).q;
      expect(q).toContain("is:pr");
      expect(q).toContain("repo:octocat/Hello-World");
    }
  });
});

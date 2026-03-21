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

    expect(result.length).toBe(searchIssuesFixture.items.length);
    expect(result[0].id).toBe(searchIssuesFixture.items[0].id);
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

    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    expect(result.length).toBe(1);
    expect(result[0].id).toBe(searchIssuesFixture.items[0].id);
  });

  it("maps search result fields to camelCase issue shape", async () => {
    const octokit = makeSearchOctokit();
    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    const issue = result[0];
    expect(issue.htmlUrl).toBeDefined();
    expect(issue.createdAt).toBeDefined();
    expect(issue.updatedAt).toBeDefined();
    expect(issue.userLogin).toBeDefined();
    expect(issue.userAvatarUrl).toBeDefined();
    expect(issue.assigneeLogins).toBeDefined();
    expect(issue.repoFullName).toBe("octocat/Hello-World");
  });

  it("returns empty array when repos is empty", async () => {
    const octokit = makeSearchOctokit();
    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [],
      "octocat"
    );

    expect(result).toEqual([]);
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
    expect(result.length).toBe(1);
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

    const result = await fetchPullRequests(
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
    for (const pr of result) {
      expect(["success", "failure", "pending", null]).toContain(pr.checkStatus);
    }
  });

  it("maps GraphQL statusCheckRollup states correctly", async () => {
    // Test FAILURE state
    const octokitFailure = makeOctokitForPRs();
    (octokitFailure as Record<string, unknown>).graphql = vi.fn(async () => ({
      pr0: { object: { statusCheckRollup: { state: "FAILURE" } } },
    }));
    const failures = await fetchPullRequests(
      octokitFailure as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );
    expect(failures[0].checkStatus).toBe("failure");

    await clearCache();

    // Test PENDING state
    const octokitPending = makeOctokitForPRs();
    (octokitPending as Record<string, unknown>).graphql = vi.fn(async () => ({
      pr0: { object: { statusCheckRollup: { state: "PENDING" } } },
    }));
    const pending = await fetchPullRequests(
      octokitPending as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );
    expect(pending[0].checkStatus).toBe("pending");

    await clearCache();

    // Test null (no checks)
    const octokitNull = makeOctokitForPRs();
    (octokitNull as Record<string, unknown>).graphql = vi.fn(async () => ({
      pr0: { object: null },
    }));
    const nullChecks = await fetchPullRequests(
      octokitNull as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );
    expect(nullChecks[0].checkStatus).toBeNull();
  });

  it("falls back to null check status on GraphQL error", async () => {
    const octokit = makeOctokitForPRs();
    (octokit as Record<string, unknown>).graphql = vi.fn(async () => {
      throw new Error("GraphQL error");
    });

    const result = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // Should still return PRs, just with null check status
    expect(result.length).toBe(1);
    expect(result[0].checkStatus).toBeNull();
  });

  it("maps PR detail fields to camelCase shape", async () => {
    const octokit = makeOctokitForPRs();

    const result = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    const pr = result[0];
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

    const result = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // Only 1 PR despite being found by potentially both search queries
    expect(result.length).toBe(1);
  });

  it("returns empty array when repos is empty", async () => {
    const octokit = makeOctokitForPRs();
    const result = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [],
      "octocat"
    );
    expect(result).toEqual([]);
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

    const result = await fetchWorkflowRuns(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      5,
      3
    );

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
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
    const result = await fetchWorkflowRuns(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      maxWorkflows,
      maxRuns
    );

    // Group result by workflowId and check each has at most maxRuns
    const byWorkflow = new Map<number, number>();
    for (const run of result) {
      byWorkflow.set(run.workflowId, (byWorkflow.get(run.workflowId) ?? 0) + 1);
    }
    for (const count of byWorkflow.values()) {
      expect(count).toBeLessThanOrEqual(maxRuns);
    }
  });

  it("respects maxWorkflows limit", async () => {
    const octokit = makeOctokitForRuns();

    const maxWorkflows = 1;
    const result = await fetchWorkflowRuns(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      maxWorkflows,
      10
    );

    // All runs should be from a single workflow
    const workflowIds = new Set(result.map((r) => r.workflowId));
    expect(workflowIds.size).toBeLessThanOrEqual(maxWorkflows);
  });

  it("tags PR-triggered runs with isPrRun=true", async () => {
    const octokit = makeOctokitForRuns();

    const result = await fetchWorkflowRuns(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      5,
      10
    );

    // Run 9003 has event: "pull_request"
    const prRun = result.find((r) => r.id === 9003);
    if (prRun) {
      expect(prRun.isPrRun).toBe(true);
    }

    // Run 9001 has event: "push"
    const pushRun = result.find((r) => r.id === 9001);
    if (pushRun) {
      expect(pushRun.isPrRun).toBe(false);
    }
  });

  it("maps raw run fields to camelCase shape", async () => {
    const octokit = makeOctokitForRuns();

    const result = await fetchWorkflowRuns(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      5,
      3
    );

    const run = result[0];
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

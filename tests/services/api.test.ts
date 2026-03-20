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
import issuesFixture from "../fixtures/github-issues.json";
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

// ── fetchIssues ───────────────────────────────────────────────────────────────

describe("fetchIssues", () => {
  it("deduplicates issues across involvement types", async () => {
    // Return the same issue fixture from all 3 involvement calls
    const singleIssue = [issuesFixture[0]];
    const octokit = {
      request: vi.fn().mockResolvedValue({
        data: singleIssue,
        headers: { etag: "etag-issues" },
      }),
      paginate: { iterator: vi.fn() },
    };

    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // Even though called 3 times (creator/assignee/mentioned), only 1 unique issue
    expect(result.length).toBe(1);
    expect(result[0].id).toBe(issuesFixture[0].id);
  });

  it("filters out pull requests (items with pull_request property)", async () => {
    const mixedData = [
      issuesFixture[0],
      { ...issuesFixture[1], pull_request: { url: "https://..." } },
    ];
    const octokit = {
      request: vi.fn().mockResolvedValue({
        data: mixedData,
        headers: { etag: "etag-mixed" },
      }),
      paginate: { iterator: vi.fn() },
    };

    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    expect(result.every((i) => !("pull_request" in i))).toBe(true);
    // Only the non-PR item should be in results
    expect(result.find((i) => i.id === issuesFixture[1].id)).toBeUndefined();
  });

  it("maps raw fields to camelCase issue shape", async () => {
    const octokit = {
      request: vi.fn().mockResolvedValue({
        data: [issuesFixture[0]],
        headers: { etag: "etag-shape" },
      }),
      paginate: { iterator: vi.fn() },
    };

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
    expect(issue.repoFullName).toBeDefined();
  });

  it("uses Promise.allSettled — partial failures do not throw", async () => {
    const octokit = {
      request: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("500"), { status: 500 }))
        .mockResolvedValue({
          data: [issuesFixture[0]],
          headers: { etag: "etag-partial" },
        }),
      paginate: { iterator: vi.fn() },
    };

    // Should not throw even if some calls fail
    const result = await fetchIssues(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );
    expect(Array.isArray(result)).toBe(true);
  });

  it("throws when octokit is null", async () => {
    await expect(fetchIssues(null, [testRepo], "octocat")).rejects.toThrow(
      "No GitHub client available"
    );
  });
});

// ── fetchPullRequests ─────────────────────────────────────────────────────────

describe("fetchPullRequests", () => {
  function makeOctokitForPRs() {
    const request = vi.fn(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/pulls") {
        return { data: prsFixture, headers: { etag: "etag-prs" } };
      }
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}/status") {
        return {
          data: runsFixture.commit_status,
          headers: { etag: "etag-status" },
        };
      }
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
        return {
          data: runsFixture.check_runs,
          headers: { etag: "etag-checks" },
        };
      }
      return { data: [], headers: {} };
    });
    return { request, paginate: { iterator: vi.fn() } };
  }

  it("returns only PRs involving the user", async () => {
    const octokit = makeOctokitForPRs();

    const result = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    // PR #10 is by octocat, so it should be included
    expect(result.some((pr) => pr.number === 10)).toBe(true);
    // PR #11 is by devuser (not octocat), not assigned, not reviewer → excluded
    expect(result.some((pr) => pr.number === 11)).toBe(false);
  });

  it("attaches check status to each PR", async () => {
    const octokit = makeOctokitForPRs();

    const result = await fetchPullRequests(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      "octocat"
    );

    for (const pr of result) {
      // checkStatus is one of "success" | "failure" | "pending" | null
      expect(["success", "failure", "pending", null]).toContain(pr.checkStatus);
    }
  });

  it("maps raw PR fields to camelCase shape", async () => {
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

  it("throws when octokit is null", async () => {
    await expect(
      fetchPullRequests(null, [testRepo], "octocat")
    ).rejects.toThrow("No GitHub client available");
  });
});

// ── fetchWorkflowRuns ─────────────────────────────────────────────────────────

describe("fetchWorkflowRuns", () => {
  function makeOctokitForRuns() {
    const request = vi.fn(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/actions/workflows") {
        return {
          data: {
            workflows: runsFixture.workflows,
            total_count: runsFixture.workflows.length,
          },
          headers: { etag: "etag-workflows" },
        };
      }
      if (
        route ===
        "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs"
      ) {
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

  it("returns runs for each repo and workflow", async () => {
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

  it("respects maxRuns per workflow", async () => {
    const octokit = makeOctokitForRuns();

    const maxWorkflows = 3;
    const maxRuns = 2;
    const result = await fetchWorkflowRuns(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      maxWorkflows,
      maxRuns
    );

    // Total runs should be at most maxWorkflows * maxRuns
    expect(result.length).toBeLessThanOrEqual(maxWorkflows * maxRuns);
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

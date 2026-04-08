// ── MCP tools.ts unit tests ───────────────────────────────────────────────────
// Tests each of the 6 tools using a mock DataSource. Tools are tested by
// calling the registered handler directly via server._registeredTools.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools.js";
import type { DataSource } from "../src/data-source.js";
import type {
  Issue,
  PullRequest,
  WorkflowRun,
  DashboardSummary,
  RateLimitInfo,
} from "../../src/shared/types.js";
import { makeIssue, makePullRequest, makeWorkflowRun } from "../../tests/helpers/factories.js";

// ── Mock ws-relay module ───────────────────────────────────────────────────────
// Tools call isRelayConnected() — mock to return false (not connected)
vi.mock("../src/ws-relay.js", () => ({
  isRelayConnected: () => false,
  sendRelayRequest: vi.fn(),
  onNotification: vi.fn(),
  startWebSocketServer: vi.fn(),
  closeWebSocketServer: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock DataSource ────────────────────────────────────────────────────────────

function makeMockDataSource(overrides: Partial<DataSource> = {}): DataSource {
  const defaultSummary: DashboardSummary = {
    openPRCount: 3,
    openIssueCount: 5,
    failingRunCount: 1,
    needsReviewCount: 2,
    approvedUnmergedCount: 1,
  };
  const defaultRateLimit: RateLimitInfo = {
    limit: 5000,
    remaining: 4800,
    resetAt: new Date("2026-04-07T12:00:00Z"),
  };

  return {
    getDashboardSummary: vi.fn().mockResolvedValue(defaultSummary),
    getOpenPRs: vi.fn().mockResolvedValue([]),
    getOpenIssues: vi.fn().mockResolvedValue([]),
    getFailingActions: vi.fn().mockResolvedValue([]),
    getPRDetails: vi.fn().mockResolvedValue(null),
    getRateLimit: vi.fn().mockResolvedValue(defaultRateLimit),
    getConfig: vi.fn().mockResolvedValue(null),
    getRepos: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// ── Helper: call a registered tool handler directly ───────────────────────────

type ToolRegistry = Record<
  string,
  { handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown> }
>;

async function callTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const tools = (server as unknown as { _registeredTools: ToolRegistry })._registeredTools;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool not found: ${toolName}`);
  return tool.handler(args, {}) as Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("get_dashboard_summary", () => {
  let server: McpServer;
  let ds: DataSource;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    ds = makeMockDataSource();
    registerTools(server, ds);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns structured summary with counts", async () => {
    const result = await callTool(server, "get_dashboard_summary", { scope: "involves_me" });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("Open PRs:");
    expect(text).toContain("3");
    expect(text).toContain("Open Issues:");
    expect(text).toContain("5");
    expect(text).toContain("Failing CI Runs:");
    expect(text).toContain("1");
    expect(text).toContain("Needs Review:");
    expect(text).toContain("2");
  });

  it("passes scope to data source", async () => {
    await callTool(server, "get_dashboard_summary", { scope: "all" });
    expect(ds.getDashboardSummary).toHaveBeenCalledWith("all");
  });

  it("defaults scope to involves_me", async () => {
    await callTool(server, "get_dashboard_summary", {});
    expect(ds.getDashboardSummary).toHaveBeenCalledWith("involves_me");
  });

  it("returns error content on data source failure", async () => {
    vi.mocked(ds.getDashboardSummary).mockRejectedValueOnce(new Error("API error"));
    const result = await callTool(server, "get_dashboard_summary");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error fetching dashboard summary");
    expect(result.content[0].text).toContain("API error");
  });

  it("includes staleness note when relay is disconnected", async () => {
    const result = await callTool(server, "get_dashboard_summary");
    // isRelayConnected is mocked to return false, so staleness note should be present
    expect(result.content[0].text).toContain("data via GitHub API");
  });
});

describe("get_open_prs", () => {
  let server: McpServer;
  let ds: DataSource;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    ds = makeMockDataSource();
    registerTools(server, ds);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 'no PRs' message when empty", async () => {
    const result = await callTool(server, "get_open_prs");
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("No open pull requests found");
  });

  it("returns formatted PR list", async () => {
    const pr = makePullRequest({ number: 42, title: "My Feature PR", repoFullName: "owner/repo" });
    vi.mocked(ds.getOpenPRs).mockResolvedValueOnce([pr]);
    const result = await callTool(server, "get_open_prs");
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("#42");
    expect(text).toContain("My Feature PR");
    expect(text).toContain("owner/repo");
  });

  it("passes repo filter to data source", async () => {
    await callTool(server, "get_open_prs", { repo: "owner/repo" });
    expect(ds.getOpenPRs).toHaveBeenCalledWith("owner/repo", undefined);
  });

  it("passes status filter to data source", async () => {
    await callTool(server, "get_open_prs", { status: "needs_review" });
    expect(ds.getOpenPRs).toHaveBeenCalledWith(undefined, "needs_review");
  });

  it("passes both repo and status filters", async () => {
    await callTool(server, "get_open_prs", { repo: "owner/repo", status: "failing" });
    expect(ds.getOpenPRs).toHaveBeenCalledWith("owner/repo", "failing");
  });

  it("shows draft badge on draft PRs", async () => {
    const pr = makePullRequest({ draft: true, title: "WIP draft" });
    vi.mocked(ds.getOpenPRs).mockResolvedValueOnce([pr]);
    const result = await callTool(server, "get_open_prs");
    expect(result.content[0].text).toContain("[DRAFT]");
  });

  it("shows review decision badge", async () => {
    const pr = makePullRequest({ reviewDecision: "APPROVED", title: "Approved PR" });
    vi.mocked(ds.getOpenPRs).mockResolvedValueOnce([pr]);
    const result = await callTool(server, "get_open_prs");
    expect(result.content[0].text).toContain("[APPROVED]");
  });

  it("shows check status", async () => {
    const pr = makePullRequest({ checkStatus: "failure", title: "Failing checks PR" });
    vi.mocked(ds.getOpenPRs).mockResolvedValueOnce([pr]);
    const result = await callTool(server, "get_open_prs");
    expect(result.content[0].text).toContain("[checks: failure]");
  });

  it("returns error content on data source failure", async () => {
    vi.mocked(ds.getOpenPRs).mockRejectedValueOnce(new Error("network error"));
    const result = await callTool(server, "get_open_prs");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error fetching open PRs");
  });
});

describe("get_open_issues", () => {
  let server: McpServer;
  let ds: DataSource;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    ds = makeMockDataSource();
    registerTools(server, ds);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 'no issues' message when empty", async () => {
    const result = await callTool(server, "get_open_issues");
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("No open issues found");
  });

  it("returns formatted issue list", async () => {
    const issue = makeIssue({ number: 7, title: "Bug report", repoFullName: "owner/repo" });
    vi.mocked(ds.getOpenIssues).mockResolvedValueOnce([issue]);
    const result = await callTool(server, "get_open_issues");
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("#7");
    expect(text).toContain("Bug report");
    expect(text).toContain("owner/repo");
  });

  it("passes repo filter to data source", async () => {
    await callTool(server, "get_open_issues", { repo: "myorg/myrepo" });
    expect(ds.getOpenIssues).toHaveBeenCalledWith("myorg/myrepo");
  });

  it("shows issue labels in output", async () => {
    const issue = makeIssue({
      title: "Labeled issue",
      labels: [{ name: "bug", color: "d73a4a" }],
    });
    vi.mocked(ds.getOpenIssues).mockResolvedValueOnce([issue]);
    const result = await callTool(server, "get_open_issues");
    expect(result.content[0].text).toContain("[bug]");
  });

  it("returns error content on data source failure", async () => {
    vi.mocked(ds.getOpenIssues).mockRejectedValueOnce(new Error("500"));
    const result = await callTool(server, "get_open_issues");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error fetching open issues");
  });
});

describe("get_failing_actions", () => {
  let server: McpServer;
  let ds: DataSource;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    ds = makeMockDataSource();
    registerTools(server, ds);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 'no failing runs' message when empty", async () => {
    const result = await callTool(server, "get_failing_actions");
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("No failing or in-progress workflow runs found");
  });

  it("returns formatted run list with conclusion", async () => {
    const run = makeWorkflowRun({
      name: "CI Build",
      conclusion: "failure",
      repoFullName: "owner/repo",
      runNumber: 99,
    });
    vi.mocked(ds.getFailingActions).mockResolvedValueOnce([run]);
    const result = await callTool(server, "get_failing_actions");
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("CI Build");
    expect(text).toContain("[failure]");
    expect(text).toContain("Run #99");
    expect(text).toContain("owner/repo");
  });

  it("shows in_progress status when conclusion is null", async () => {
    const run = makeWorkflowRun({
      name: "Running",
      status: "in_progress",
      conclusion: null,
    });
    vi.mocked(ds.getFailingActions).mockResolvedValueOnce([run]);
    const result = await callTool(server, "get_failing_actions");
    expect(result.content[0].text).toContain("[in_progress]");
  });

  it("passes repo filter to data source", async () => {
    await callTool(server, "get_failing_actions", { repo: "owner/repo" });
    expect(ds.getFailingActions).toHaveBeenCalledWith("owner/repo");
  });

  it("returns error content on data source failure", async () => {
    vi.mocked(ds.getFailingActions).mockRejectedValueOnce(new Error("timeout"));
    const result = await callTool(server, "get_failing_actions");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error fetching workflow runs");
  });
});

describe("get_pr_details", () => {
  let server: McpServer;
  let ds: DataSource;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    ds = makeMockDataSource();
    registerTools(server, ds);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 'not found' message for nonexistent PR", async () => {
    vi.mocked(ds.getPRDetails).mockResolvedValueOnce(null);
    const result = await callTool(server, "get_pr_details", {
      repo: "owner/repo",
      number: 999,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("#999 not found in owner/repo");
  });

  it("returns detailed PR info for existing PR", async () => {
    const pr = makePullRequest({
      number: 42,
      title: "Feature branch",
      repoFullName: "owner/repo",
      userLogin: "alice",
      headRef: "feat/my-feature",
      baseRef: "main",
      additions: 100,
      deletions: 20,
      changedFiles: 5,
      comments: 3,
      reviewThreads: 1,
    });
    vi.mocked(ds.getPRDetails).mockResolvedValueOnce(pr);
    const result = await callTool(server, "get_pr_details", {
      repo: "owner/repo",
      number: 42,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("PR #42: Feature branch");
    expect(text).toContain("alice");
    expect(text).toContain("feat/my-feature");
    expect(text).toContain("main");
    expect(text).toContain("+100 / -20");
    expect(text).toContain("5 files");
  });

  it("calls data source with repo and number", async () => {
    await callTool(server, "get_pr_details", { repo: "owner/repo", number: 5 });
    expect(ds.getPRDetails).toHaveBeenCalledWith("owner/repo", 5);
  });

  it("shows review decision and check status when present", async () => {
    const pr = makePullRequest({
      reviewDecision: "CHANGES_REQUESTED",
      checkStatus: "pending",
      reviewerLogins: ["bob", "charlie"],
    });
    vi.mocked(ds.getPRDetails).mockResolvedValueOnce(pr);
    const result = await callTool(server, "get_pr_details", {
      repo: "owner/repo",
      number: 1,
    });
    const text = result.content[0].text;
    expect(text).toContain("CHANGES_REQUESTED");
    expect(text).toContain("pending");
    expect(text).toContain("bob");
    expect(text).toContain("charlie");
  });

  it("shows draft indicator for draft PRs", async () => {
    const pr = makePullRequest({ draft: true });
    vi.mocked(ds.getPRDetails).mockResolvedValueOnce(pr);
    const result = await callTool(server, "get_pr_details", {
      repo: "owner/repo",
      number: 1,
    });
    expect(result.content[0].text).toContain("draft");
  });

  it("returns error content on data source failure", async () => {
    vi.mocked(ds.getPRDetails).mockRejectedValueOnce(new Error("rate limit exceeded"));
    const result = await callTool(server, "get_pr_details", {
      repo: "owner/repo",
      number: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error fetching PR details");
    expect(result.content[0].text).toContain("rate limit exceeded");
  });
});

describe("get_rate_limit", () => {
  let server: McpServer;
  let ds: DataSource;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    ds = makeMockDataSource();
    registerTools(server, ds);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns formatted rate limit info", async () => {
    const result = await callTool(server, "get_rate_limit");
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("GitHub API Rate Limit");
    expect(text).toContain("4800");
    expect(text).toContain("5000");
    expect(text).toContain("96%");
  });

  it("calls getRateLimit on data source", async () => {
    await callTool(server, "get_rate_limit");
    expect(ds.getRateLimit).toHaveBeenCalled();
  });

  it("shows resets at time", async () => {
    const result = await callTool(server, "get_rate_limit");
    expect(result.content[0].text).toContain("Resets at:");
  });

  it("returns error content on data source failure", async () => {
    vi.mocked(ds.getRateLimit).mockRejectedValueOnce(new Error("unauthorized"));
    const result = await callTool(server, "get_rate_limit");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error fetching rate limit");
  });
});

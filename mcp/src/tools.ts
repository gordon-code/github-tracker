// ── MCP tool registration ─────────────────────────────────────────────────────
// Registers all 6 GitHub Tracker tools with the MCP server.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { METHODS } from "../../src/shared/protocol.js";
import type { DataSource } from "./data-source.js";
import type {
  Issue,
  PullRequest,
  WorkflowRun,
  DashboardSummary,
  RateLimitInfo,
} from "../../src/shared/types.js";
import { isRelayConnected } from "./ws-relay.js";

// ── Formatting helpers ────────────────────────────────────────────────────────

function stalenessLine(): string {
  // Relay mode has no staleness annotation (data is live from SPA dashboard).
  // Octokit mode notes that data comes via the GitHub API directly.
  // Ideally relay mode would show "Data as of X ago" using lastUpdatedAt, but that
  // field lives in the SPA's RelaySnapshot and isn't forwarded to the MCP server.
  return isRelayConnected()
    ? ""
    : "\n_(data via GitHub API — connect SPA for live dashboard data)_";
}

function formatPR(pr: PullRequest, index: number): string {
  const lines: string[] = [];
  const idx = `${index + 1}.`;
  const draft = pr.draft ? " [DRAFT]" : "";
  const review = pr.reviewDecision ? ` [${pr.reviewDecision}]` : "";
  const checks = pr.checkStatus ? ` [checks: ${pr.checkStatus}]` : "";
  lines.push(`${idx} #${pr.number} ${pr.title}${draft}${review}${checks}`);
  lines.push(`   Repo: ${pr.repoFullName} | Author: ${pr.userLogin}`);
  if (pr.reviewerLogins.length > 0) {
    lines.push(`   Reviewers: ${pr.reviewerLogins.join(", ")}`);
  }
  if (pr.additions || pr.deletions) {
    lines.push(`   Changes: +${pr.additions} / -${pr.deletions} (${pr.changedFiles} files)`);
  }
  lines.push(`   URL: ${pr.htmlUrl}`);
  lines.push(`   Updated: ${new Date(pr.updatedAt).toLocaleString()}`);
  return lines.join("\n");
}

function formatIssue(issue: Issue, index: number): string {
  const lines: string[] = [];
  const idx = `${index + 1}.`;
  const labels = issue.labels.length > 0 ? ` [${issue.labels.map((l) => l.name).join(", ")}]` : "";
  lines.push(`${idx} #${issue.number} ${issue.title}${labels}`);
  lines.push(`   Repo: ${issue.repoFullName} | Author: ${issue.userLogin}`);
  lines.push(`   URL: ${issue.htmlUrl}`);
  lines.push(`   Updated: ${new Date(issue.updatedAt).toLocaleString()}`);
  return lines.join("\n");
}

function formatRun(run: WorkflowRun, index: number): string {
  const lines: string[] = [];
  const idx = `${index + 1}.`;
  const conclusion = run.conclusion ? ` [${run.conclusion}]` : ` [${run.status}]`;
  lines.push(`${idx} ${run.name}${conclusion} — Run #${run.runNumber}`);
  lines.push(`   Repo: ${run.repoFullName} | Branch: ${run.headBranch} | Trigger: ${run.event}`);
  lines.push(`   URL: ${run.htmlUrl}`);
  lines.push(`   Started: ${new Date(run.runStartedAt).toLocaleString()}`);
  return lines.join("\n");
}

function formatSummary(summary: DashboardSummary, scope: string): string {
  const lines: string[] = [
    `GitHub Tracker Dashboard Summary (scope: ${scope})`,
    "─".repeat(50),
    `Open PRs:         ${summary.openPRCount}`,
    `Open Issues:      ${summary.openIssueCount}`,
    `Failing CI Runs:  ${summary.failingRunCount}`,
    `Needs Review:     ${summary.needsReviewCount}`,
    `Approved/Unmerged: ${summary.approvedUnmergedCount}`,
  ];
  return lines.join("\n");
}

function formatRateLimit(rl: RateLimitInfo): string {
  const resetTime = rl.resetAt instanceof Date ? rl.resetAt : new Date(rl.resetAt);
  const resetIn = Math.max(0, Math.round((resetTime.getTime() - Date.now()) / 1000));
  const pct = rl.limit > 0 ? Math.round((rl.remaining / rl.limit) * 100) : 0;
  return [
    "GitHub API Rate Limit",
    "─".repeat(30),
    `Remaining: ${rl.remaining} / ${rl.limit} (${pct}%)`,
    `Resets at: ${resetTime.toLocaleString()} (in ${resetIn}s)`,
  ].join("\n");
}

// ── Tool registration ─────────────────────────────────────────────────────────

export function registerTools(server: McpServer, dataSource: DataSource): void {
  // 1. get_dashboard_summary
  server.registerTool(
    METHODS.GET_DASHBOARD_SUMMARY,
    {
      description: "Get aggregated counts of open PRs, issues, failing CI runs, and items needing attention",
      inputSchema: {
        scope: z.enum(["involves_me", "all"]).default("involves_me"),
      },
    },
    async (args) => {
      const scope = (args as { scope?: string }).scope ?? "involves_me";
      try {
        const summary = await dataSource.getDashboardSummary(scope);
        const text = formatSummary(summary, scope) + stalenessLine();
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const text = `Error fetching dashboard summary: ${err instanceof Error ? err.message : String(err)}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // 2. get_open_prs
  server.registerTool(
    METHODS.GET_OPEN_PRS,
    {
      description: "List open pull requests with status, review decision, and metadata",
      inputSchema: {
        repo: z.string().optional(),
        status: z.enum(["all", "needs_review", "failing", "approved", "draft"]).default("all"),
      },
    },
    async (args) => {
      const { repo, status } = args as { repo?: string; status?: string };
      try {
        const prs = await dataSource.getOpenPRs(repo, status);
        if (prs.length === 0) {
          const text = `No open pull requests found${repo ? ` in ${repo}` : ""}${status && status !== "all" ? ` with status: ${status}` : ""}.` + stalenessLine();
          return { content: [{ type: "text" as const, text }] };
        }
        const header = `Open Pull Requests (${prs.length})${repo ? ` — ${repo}` : ""}`;
        const body = prs.map((pr, i) => formatPR(pr, i)).join("\n\n");
        const text = `${header}\n${"─".repeat(header.length)}\n\n${body}${stalenessLine()}`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const text = `Error fetching open PRs: ${err instanceof Error ? err.message : String(err)}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // 3. get_open_issues
  server.registerTool(
    METHODS.GET_OPEN_ISSUES,
    {
      description: "List open issues across tracked repos",
      inputSchema: {
        repo: z.string().optional(),
      },
    },
    async (args) => {
      const { repo } = args as { repo?: string };
      try {
        const issues = await dataSource.getOpenIssues(repo);
        if (issues.length === 0) {
          const text = `No open issues found${repo ? ` in ${repo}` : ""}.` + stalenessLine();
          return { content: [{ type: "text" as const, text }] };
        }
        const header = `Open Issues (${issues.length})${repo ? ` — ${repo}` : ""}`;
        const body = issues.map((issue, i) => formatIssue(issue, i)).join("\n\n");
        const text = `${header}\n${"─".repeat(header.length)}\n\n${body}${stalenessLine()}`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const text = `Error fetching open issues: ${err instanceof Error ? err.message : String(err)}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // 4. get_failing_actions
  server.registerTool(
    METHODS.GET_FAILING_ACTIONS,
    {
      description: "List in-progress or recently failed GitHub Actions workflow runs",
      inputSchema: {
        repo: z.string().optional(),
      },
    },
    async (args) => {
      const { repo } = args as { repo?: string };
      try {
        const runs = await dataSource.getFailingActions(repo);
        if (runs.length === 0) {
          const text = `No failing or in-progress workflow runs found${repo ? ` in ${repo}` : ""}.` + stalenessLine();
          return { content: [{ type: "text" as const, text }] };
        }
        const header = `Failing/In-Progress Actions (${runs.length})${repo ? ` — ${repo}` : ""}`;
        const body = runs.map((run, i) => formatRun(run, i)).join("\n\n");
        const text = `${header}\n${"─".repeat(header.length)}\n\n${body}${stalenessLine()}`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const text = `Error fetching workflow runs: ${err instanceof Error ? err.message : String(err)}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // 5. get_pr_details
  server.registerTool(
    METHODS.GET_PR_DETAILS,
    {
      description: "Get detailed information about a specific pull request",
      inputSchema: {
        repo: z.string(),
        number: z.number().int().positive(),
      },
    },
    async (args) => {
      const { repo, number } = args as { repo: string; number: number };
      try {
        const pr = await dataSource.getPRDetails(repo, number);
        if (!pr) {
          const text = `Pull request #${number} not found in ${repo}.`;
          return { content: [{ type: "text" as const, text }] };
        }
        const header = `PR #${pr.number}: ${pr.title}`;
        const lines = [
          header,
          "─".repeat(Math.min(header.length, 80)),
          `Repo:   ${pr.repoFullName}`,
          `Author: ${pr.userLogin}`,
          `State:  ${pr.state}${pr.draft ? " (draft)" : ""}`,
          `Branch: ${pr.headRef} → ${pr.baseRef}`,
        ];
        if (pr.reviewDecision) lines.push(`Review Decision: ${pr.reviewDecision}`);
        if (pr.checkStatus) lines.push(`Checks: ${pr.checkStatus}`);
        if (pr.reviewerLogins.length > 0) lines.push(`Reviewers: ${pr.reviewerLogins.join(", ")}`);
        if (pr.assigneeLogins.length > 0) lines.push(`Assignees: ${pr.assigneeLogins.join(", ")}`);
        if (pr.labels.length > 0) lines.push(`Labels: ${pr.labels.map((l) => l.name).join(", ")}`);
        if (pr.additions || pr.deletions) {
          lines.push(`Changes: +${pr.additions} / -${pr.deletions} (${pr.changedFiles} files)`);
        }
        lines.push(`Comments: ${pr.comments} | Review threads: ${pr.reviewThreads}`);
        lines.push(`URL: ${pr.htmlUrl}`);
        lines.push(`Updated: ${new Date(pr.updatedAt).toLocaleString()}`);
        const text = lines.join("\n") + stalenessLine();
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const text = `Error fetching PR details: ${err instanceof Error ? err.message : String(err)}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // 6. get_rate_limit
  server.registerTool(
    METHODS.GET_RATE_LIMIT,
    {
      description: "Show current GitHub API rate limit status",
      inputSchema: {},
    },
    async () => {
      try {
        const rl = await dataSource.getRateLimit();
        const text = formatRateLimit(rl) + stalenessLine();
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const text = `Error fetching rate limit: ${err instanceof Error ? err.message : String(err)}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}

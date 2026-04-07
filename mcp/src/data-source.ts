// ── Data source abstractions ──────────────────────────────────────────────────
// Defines the DataSource interface plus two concrete implementations:
//   OctokitDataSource — fetches directly from GitHub REST API
//   WebSocketDataSource — forwards requests to the SPA via WebSocket relay
//   CompositeDataSource — tries WebSocket first, falls back to Octokit

import { VALID_REPO_NAME } from "../../src/shared/validation.js";
import { METHODS } from "../../src/shared/protocol.js";
import type {
  Issue,
  PullRequest,
  WorkflowRun,
  RepoRef,
  RateLimitInfo,
  DashboardSummary,
} from "../../src/shared/types.js";
import type { TrackedUser } from "../../src/shared/schemas.js";

// ── Cached config (populated by config_update notification) ───────────────────

interface CachedConfig {
  selectedRepos: RepoRef[];
  trackedUsers: TrackedUser[];
  upstreamRepos: RepoRef[];
  monitoredRepos: RepoRef[];
}

let _cachedConfig: CachedConfig | null = null;

export function setCachedConfig(c: CachedConfig): void {
  _cachedConfig = c;
}

// ── DataSource interface ──────────────────────────────────────────────────────

export interface DataSource {
  getDashboardSummary(scope: string): Promise<DashboardSummary>;
  getOpenPRs(repo?: string, status?: string): Promise<PullRequest[]>;
  getOpenIssues(repo?: string): Promise<Issue[]>;
  getFailingActions(repo?: string): Promise<WorkflowRun[]>;
  getPRDetails(repo: string, number: number): Promise<PullRequest | null>;
  getRateLimit(): Promise<RateLimitInfo>;
  getConfig(): Promise<object | null>;
  getRepos(): Promise<RepoRef[]>;
}

// ── Octokit type (avoid importing the full extended class) ────────────────────

interface OctokitLike {
  request: (route: string, params?: Record<string, unknown>) => Promise<{ data: unknown; headers: Record<string, string | number | undefined> }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function validateRepoParam(repo: string): void {
  if (!VALID_REPO_NAME.test(repo)) {
    throw new Error(`Invalid repo format: ${JSON.stringify(repo)}. Expected "owner/name".`);
  }
}

function repoParamToRepoRef(repo: string): RepoRef {
  const [owner, name] = repo.split("/");
  return { owner, name, fullName: repo };
}

/**
 * Returns repos to query: explicit param → single validated repo,
 * otherwise all repos from cached config.
 * Throws a descriptive error if no config and no explicit param.
 */
function resolveRepos(repo?: string): RepoRef[] {
  if (repo) {
    validateRepoParam(repo);
    return [repoParamToRepoRef(repo)];
  }
  if (!_cachedConfig) {
    throw new Error(
      "No repository configuration available. Either pass an explicit `repo` parameter or connect the SPA to send a config_update."
    );
  }
  return _cachedConfig.selectedRepos;
}

// ── REST search result → PullRequest mapper ───────────────────────────────────

interface SearchItem {
  id: number;
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  html_url: string;
  created_at: string;
  updated_at: string;
  user: { login: string; avatar_url: string } | null;
  repository_url: string;
  labels: { name: string; color: string }[];
  assignees: { login: string }[] | null;
  pull_request?: { merged_at: string | null };
}

function mapSearchItemToPR(item: SearchItem, repoFullName: string): PullRequest {
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    state: item.state,
    draft: item.draft ?? false,
    htmlUrl: item.html_url,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    userLogin: item.user?.login ?? "",
    userAvatarUrl: item.user?.avatar_url ?? "",
    repoFullName,
    labels: (item.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
    assigneeLogins: (item.assignees ?? []).map((a) => a.login),
    // Fields not available from REST search:
    checkStatus: null,
    reviewDecision: null,
    reviewerLogins: [],
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    enriched: false,
    headSha: "",
    headRef: "",
    baseRef: "",
    comments: 0,
    reviewThreads: 0,
    totalReviewCount: 0,
  };
}

function mapSearchItemToIssue(item: SearchItem, repoFullName: string): Issue {
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    state: item.state,
    htmlUrl: item.html_url,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    userLogin: item.user?.login ?? "",
    userAvatarUrl: item.user?.avatar_url ?? "",
    repoFullName,
    labels: (item.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
    assigneeLogins: (item.assignees ?? []).map((a) => a.login),
    comments: 0,
  };
}

interface WorkflowRunRaw {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  event: string;
  workflow_id: number;
  head_sha: string;
  head_branch: string;
  run_number: number;
  html_url: string;
  created_at: string;
  updated_at: string;
  run_started_at: string;
  // BUG-007: completed_at is present in GitHub API response but was missing from the interface.
  completed_at: string | null;
  run_attempt: number;
  display_title: string;
  actor: { login: string } | null;
  pull_requests: unknown[];
  jobs_url: string;
}

function mapWorkflowRun(raw: WorkflowRunRaw, repoFullName: string): WorkflowRun {
  return {
    id: raw.id,
    name: raw.name ?? "",
    status: raw.status ?? "",
    conclusion: raw.conclusion,
    event: raw.event ?? "",
    workflowId: raw.workflow_id,
    headSha: raw.head_sha ?? "",
    headBranch: raw.head_branch ?? "",
    runNumber: raw.run_number,
    htmlUrl: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    repoFullName,
    isPrRun: Array.isArray(raw.pull_requests) && raw.pull_requests.length > 0,
    runStartedAt: raw.run_started_at ?? raw.created_at,
    completedAt: raw.completed_at ?? null,
    runAttempt: raw.run_attempt ?? 1,
    displayTitle: raw.display_title ?? raw.name ?? "",
    actorLogin: raw.actor?.login ?? "",
  };
}

// ── OctokitDataSource ─────────────────────────────────────────────────────────

export class OctokitDataSource implements DataSource {
  private readonly octokit: OctokitLike;
  private _login: string | null = null;

  constructor(octokit: OctokitLike) {
    this.octokit = octokit;
    // Discover authenticated login lazily on first use
  }

  private async getLogin(): Promise<string> {
    if (this._login) return this._login;
    // BUG-006: Throw if login cannot be determined to prevent empty `involves:` query strings.
    const { data } = await this.octokit.request("GET /user");
    const login = (data as { login: string }).login;
    if (!login) throw new Error("Could not determine authenticated user login from GET /user");
    this._login = login;
    return this._login;
  }

  async getOpenPRs(repo?: string, status?: string): Promise<PullRequest[]> {
    const login = await this.getLogin();
    const repos = resolveRepos(repo);
    const results: PullRequest[] = [];

    // PERF-001: Batch repos into groups of 20 to avoid N+1 REST calls.
    // GitHub search supports multiple repo: qualifiers in a single query.
    const BATCH_SIZE = 20;
    const batches: RepoRef[][] = [];
    for (let i = 0; i < repos.length; i += BATCH_SIZE) {
      batches.push(repos.slice(i, i + BATCH_SIZE));
    }

    const batchResults = await Promise.allSettled(
      batches.map((batch) => {
        const repoFilter = batch.map((r) => `repo:${r.owner}/${r.name}`).join("+");
        const q = `is:pr+is:open+involves:${login}+${repoFilter}`;
        return this.octokit.request("GET /search/issues", { q, per_page: 100 }).then(({ data }) => {
          const items = (data as { items: SearchItem[] }).items ?? [];
          const prs: PullRequest[] = [];
          for (const item of items) {
            if (item.pull_request !== undefined) {
              // Derive repo from repository_url (last two segments: owner/name)
              const repoFullName = item.repository_url.replace("https://api.github.com/repos/", "");
              prs.push(mapSearchItemToPR(item, repoFullName));
            }
          }
          return prs;
        });
      })
    );

    for (const settled of batchResults) {
      if (settled.status === "fulfilled") {
        results.push(...settled.value);
      } else {
        console.error("[mcp] getOpenPRs batch error:", settled.reason instanceof Error ? settled.reason.message : String(settled.reason));
      }
    }

    if (status && status !== "all") {
      return results.filter((pr) => {
        switch (status) {
          case "draft": return pr.draft;
          case "needs_review": return pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewDecision === null;
          case "failing": return pr.checkStatus === "failure";
          case "approved": return pr.reviewDecision === "APPROVED";
          default: return true;
        }
      });
    }

    return results;
  }

  async getOpenIssues(repo?: string): Promise<Issue[]> {
    const login = await this.getLogin();
    const repos = resolveRepos(repo);
    const results: Issue[] = [];

    // PERF-002: Batch repos into groups of 20 to avoid N+1 REST calls.
    const BATCH_SIZE = 20;
    const batches: RepoRef[][] = [];
    for (let i = 0; i < repos.length; i += BATCH_SIZE) {
      batches.push(repos.slice(i, i + BATCH_SIZE));
    }

    const batchResults = await Promise.allSettled(
      batches.map((batch) => {
        const repoFilter = batch.map((r) => `repo:${r.owner}/${r.name}`).join("+");
        const q = `is:issue+is:open+involves:${login}+${repoFilter}`;
        return this.octokit.request("GET /search/issues", { q, per_page: 100 }).then(({ data }) => {
          const items = (data as { items: SearchItem[] }).items ?? [];
          const issues: Issue[] = [];
          for (const item of items) {
            // Filter out PRs from issue search
            if (item.pull_request === undefined) {
              const repoFullName = item.repository_url.replace("https://api.github.com/repos/", "");
              issues.push(mapSearchItemToIssue(item, repoFullName));
            }
          }
          return issues;
        });
      })
    );

    for (const settled of batchResults) {
      if (settled.status === "fulfilled") {
        results.push(...settled.value);
      } else {
        console.error("[mcp] getOpenIssues batch error:", settled.reason instanceof Error ? settled.reason.message : String(settled.reason));
      }
    }

    return results;
  }

  async getFailingActions(repo?: string): Promise<WorkflowRun[]> {
    const repos = resolveRepos(repo);

    // PERF-003: Collect all {repo, status} pairs and run them in parallel.
    const pairs = repos.flatMap((r) =>
      (["in_progress", "failure"] as const).map((status) => ({ r, status }))
    );

    const settled = await Promise.allSettled(
      pairs.map(({ r, status }) =>
        this.octokit.request(
          "GET /repos/{owner}/{repo}/actions/runs",
          { owner: r.owner, repo: r.name, status, per_page: 20 }
        ).then(({ data }) => {
          const runs = (data as { workflow_runs: WorkflowRunRaw[] }).workflow_runs ?? [];
          return runs.map((run) => mapWorkflowRun(run, r.fullName));
        })
      )
    );

    const results: WorkflowRun[] = [];
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === "fulfilled") {
        results.push(...result.value);
      } else {
        const { r, status } = pairs[i];
        console.error(`[mcp] getFailingActions error for ${r.fullName} (${status}):`, result.reason instanceof Error ? result.reason.message : String(result.reason));
      }
    }

    return results;
  }

  async getPRDetails(repo: string, number: number): Promise<PullRequest | null> {
    validateRepoParam(repo);
    const [owner, name] = repo.split("/");
    try {
      const { data } = await this.octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        { owner, repo: name, pull_number: number }
      );
      const raw = data as {
        id: number;
        number: number;
        title: string;
        state: string;
        draft: boolean;
        html_url: string;
        created_at: string;
        updated_at: string;
        user: { login: string; avatar_url: string } | null;
        head: { sha: string; ref: string };
        base: { ref: string };
        assignees: { login: string }[];
        requested_reviewers: { login: string }[];
        labels: { name: string; color: string }[];
        additions: number;
        deletions: number;
        changed_files: number;
        comments: number;
        review_comments: number;
      };
      return {
        id: raw.id,
        number: raw.number,
        title: raw.title,
        state: raw.state,
        draft: raw.draft ?? false,
        htmlUrl: raw.html_url,
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
        userLogin: raw.user?.login ?? "",
        userAvatarUrl: raw.user?.avatar_url ?? "",
        headSha: raw.head.sha,
        headRef: raw.head.ref,
        baseRef: raw.base.ref,
        assigneeLogins: (raw.assignees ?? []).map((a) => a.login),
        reviewerLogins: (raw.requested_reviewers ?? []).map((r) => r.login),
        repoFullName: repo,
        checkStatus: null,
        additions: raw.additions ?? 0,
        deletions: raw.deletions ?? 0,
        changedFiles: raw.changed_files ?? 0,
        comments: (raw.comments ?? 0) + (raw.review_comments ?? 0),
        reviewThreads: raw.review_comments ?? 0,
        labels: (raw.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
        reviewDecision: null,
        totalReviewCount: 0,
        enriched: true,
      };
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) return null;
      throw err;
    }
  }

  async getRateLimit(): Promise<RateLimitInfo> {
    const { data } = await this.octokit.request("GET /rate_limit");
    const core = (data as { rate: { limit: number; remaining: number; reset: number } }).rate;
    return {
      limit: core.limit,
      remaining: core.remaining,
      resetAt: new Date(core.reset * 1000),
    };
  }

  async getDashboardSummary(scope: string): Promise<DashboardSummary> {
    const login = await this.getLogin();
    const repos = _cachedConfig?.selectedRepos ?? [];

    if (repos.length === 0) {
      return { openPRCount: 0, openIssueCount: 0, failingRunCount: 0, needsReviewCount: 0, approvedUnmergedCount: 0 };
    }

    const repoFilter = repos.map((r) => `repo:${r.owner}/${r.name}`).join("+");
    const involvesPart = scope === "involves_me" ? `+involves:${login}` : "";

    let openPRCount = 0;
    let openIssueCount = 0;
    let needsReviewCount = 0;
    let approvedUnmergedCount = 0;
    let failingRunCount = 0;

    try {
      const prQuery = `is:pr+is:open${involvesPart}+${repoFilter}`;
      const { data: prData } = await this.octokit.request("GET /search/issues", { q: prQuery, per_page: 1 });
      openPRCount = (prData as { total_count: number }).total_count;
    } catch (err) {
      console.error("[mcp] getDashboardSummary PR count error:", err instanceof Error ? err.message : String(err));
    }

    try {
      const issueQuery = `is:issue+is:open${involvesPart}+${repoFilter}`;
      const { data: issueData } = await this.octokit.request("GET /search/issues", { q: issueQuery, per_page: 1 });
      openIssueCount = (issueData as { total_count: number }).total_count;
    } catch (err) {
      console.error("[mcp] getDashboardSummary issue count error:", err instanceof Error ? err.message : String(err));
    }

    try {
      const reviewQuery = `is:pr+is:open+review-requested:${login}+${repoFilter}`;
      const { data: reviewData } = await this.octokit.request("GET /search/issues", { q: reviewQuery, per_page: 1 });
      needsReviewCount = (reviewData as { total_count: number }).total_count;
    } catch (err) {
      console.error("[mcp] getDashboardSummary review count error:", err instanceof Error ? err.message : String(err));
    }

    // Failing runs: count across all repos (BUG-008: use total_count, not repo presence).
    // Run in parallel with Promise.allSettled for performance (PERF-003).
    const failingRunResults = await Promise.allSettled(
      repos.map((r) =>
        this.octokit.request(
          "GET /repos/{owner}/{repo}/actions/runs",
          { owner: r.owner, repo: r.name, status: "failure", per_page: 5 }
        )
      )
    );
    for (const settled of failingRunResults) {
      if (settled.status === "fulfilled") {
        failingRunCount += (settled.value.data as { total_count: number }).total_count;
      }
    }

    return { openPRCount, openIssueCount, failingRunCount, needsReviewCount, approvedUnmergedCount };
  }

  async getConfig(): Promise<object | null> {
    return _cachedConfig;
  }

  async getRepos(): Promise<RepoRef[]> {
    return _cachedConfig?.selectedRepos ?? [];
  }
}

// ── WebSocketDataSource ───────────────────────────────────────────────────────
// Forwards all calls to the SPA via JSON-RPC over WebSocket relay.

import { sendRelayRequest } from "./ws-relay.js";

export class WebSocketDataSource implements DataSource {
  async getDashboardSummary(scope: string): Promise<DashboardSummary> {
    return sendRelayRequest(METHODS.GET_DASHBOARD_SUMMARY, { scope }) as Promise<DashboardSummary>;
  }

  async getOpenPRs(repo?: string, status?: string): Promise<PullRequest[]> {
    return sendRelayRequest(METHODS.GET_OPEN_PRS, { repo, status }) as Promise<PullRequest[]>;
  }

  async getOpenIssues(repo?: string): Promise<Issue[]> {
    return sendRelayRequest(METHODS.GET_OPEN_ISSUES, { repo }) as Promise<Issue[]>;
  }

  async getFailingActions(repo?: string): Promise<WorkflowRun[]> {
    return sendRelayRequest(METHODS.GET_FAILING_ACTIONS, { repo }) as Promise<WorkflowRun[]>;
  }

  async getPRDetails(repo: string, number: number): Promise<PullRequest | null> {
    return sendRelayRequest(METHODS.GET_PR_DETAILS, { repo, number }) as Promise<PullRequest | null>;
  }

  async getRateLimit(): Promise<RateLimitInfo> {
    // BUG-002: SPA relay returns { core: {...}, graphql: {...} } — unwrap the core property.
    const raw = await sendRelayRequest(METHODS.GET_RATE_LIMIT, {}) as {
      core?: { limit: number; remaining: number; resetAt: string };
      limit?: number;
      remaining?: number;
      resetAt?: string;
    };
    const core = raw.core ?? (raw as { limit: number; remaining: number; resetAt: string });
    return {
      limit: core.limit,
      remaining: core.remaining,
      resetAt: new Date(core.resetAt),
    };
  }

  async getConfig(): Promise<object | null> {
    return sendRelayRequest(METHODS.GET_CONFIG, {}) as Promise<object | null>;
  }

  async getRepos(): Promise<RepoRef[]> {
    return sendRelayRequest(METHODS.GET_REPOS, {}) as Promise<RepoRef[]>;
  }
}

// ── CompositeDataSource ───────────────────────────────────────────────────────
// Tries WebSocket relay first; falls back to Octokit when relay is unavailable.

import { isRelayConnected } from "./ws-relay.js";

type DataSourceName = "relay" | "octokit";

export class CompositeDataSource implements DataSource {
  private readonly ws: WebSocketDataSource;
  private readonly octokit: DataSource;
  private _lastSource: DataSourceName | null = null;

  constructor(ws: WebSocketDataSource, octokit: DataSource) {
    this.ws = ws;
    this.octokit = octokit;
  }

  private logTransition(source: DataSourceName): void {
    if (source !== this._lastSource) {
      console.error(`[mcp] Data source: ${source}`);
      this._lastSource = source;
    }
  }

  private async tryBoth<T>(method: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    if (isRelayConnected()) {
      try {
        const result = await method();
        this.logTransition("relay");
        return result;
      } catch (err) {
        console.error("[mcp] Relay request failed, falling back to Octokit:", err instanceof Error ? err.message : String(err));
      }
    }
    const result = await fallback();
    this.logTransition("octokit");
    return result;
  }

  async getDashboardSummary(scope: string): Promise<DashboardSummary> {
    return this.tryBoth(
      () => this.ws.getDashboardSummary(scope),
      () => this.octokit.getDashboardSummary(scope)
    );
  }

  async getOpenPRs(repo?: string, status?: string): Promise<PullRequest[]> {
    return this.tryBoth(
      () => this.ws.getOpenPRs(repo, status),
      () => this.octokit.getOpenPRs(repo, status)
    );
  }

  async getOpenIssues(repo?: string): Promise<Issue[]> {
    return this.tryBoth(
      () => this.ws.getOpenIssues(repo),
      () => this.octokit.getOpenIssues(repo)
    );
  }

  async getFailingActions(repo?: string): Promise<WorkflowRun[]> {
    return this.tryBoth(
      () => this.ws.getFailingActions(repo),
      () => this.octokit.getFailingActions(repo)
    );
  }

  async getPRDetails(repo: string, number: number): Promise<PullRequest | null> {
    return this.tryBoth(
      () => this.ws.getPRDetails(repo, number),
      () => this.octokit.getPRDetails(repo, number)
    );
  }

  async getRateLimit(): Promise<RateLimitInfo> {
    return this.tryBoth(
      () => this.ws.getRateLimit(),
      () => this.octokit.getRateLimit()
    );
  }

  async getConfig(): Promise<object | null> {
    return this.tryBoth(
      () => this.ws.getConfig(),
      () => this.octokit.getConfig()
    );
  }

  async getRepos(): Promise<RepoRef[]> {
    return this.tryBoth(
      () => this.ws.getRepos(),
      () => this.octokit.getRepos()
    );
  }
}

// ── Shared domain types ───────────────────────────────────────────────────────
// These are browser-agnostic types shared between the SPA and MCP server.

export interface OrgEntry {
  login: string;
  avatarUrl: string;
  type: "org" | "user";
}

export interface RepoRef {
  owner: string;
  name: string;
  fullName: string;
}

export interface RepoEntry extends RepoRef {
  pushedAt: string | null;
  isFork?: boolean;
}

export const REPO_CAP = 1000;

export type IssueState = "OPEN" | "CLOSED";
export type PullRequestState = "OPEN" | "CLOSED" | "MERGED";

export interface Issue {
  id: number;
  number: number;
  title: string;
  state: IssueState;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  userLogin: string;
  userAvatarUrl: string;
  labels: { name: string; color: string }[];
  assigneeLogins: string[];
  repoFullName: string;
  comments: number;
  starCount?: number;
  surfacedBy?: string[];
  nodeId?: string;
}

export interface CheckStatus {
  status: "success" | "failure" | "pending" | "conflict" | null;
}

export type AutoMergeMethod = "MERGE" | "SQUASH" | "REBASE";
export type ViewerReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

export const PR_ENRICHMENT_NOTIFICATION_SOURCE = "pr-enrichment";
export const PR_ENRICHMENT_DEGRADED_MESSAGE =
  "Some pull request details could not be loaded — showing cached data where available";
export const DASHBOARD_BODIES_STORAGE_KEY = "github-tracker:dashboard-bodies";

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  state: PullRequestState;
  draft: boolean;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  userLogin: string;
  userAvatarUrl: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  assigneeLogins: string[];
  reviewerLogins: string[];
  repoFullName: string;
  checkStatus: CheckStatus["status"];
  additions: number;
  deletions: number;
  changedFiles: number;
  comments: number;
  reviewThreads: number;
  labels: { name: string; color: string }[];
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  totalReviewCount: number;
  /** Non-null when GitHub auto-merge is enabled on the PR */
  autoMergeMethod?: AutoMergeMethod | null;
  /** True when a review has been requested of the authenticated viewer (directly or via team) */
  viewerReviewRequested?: boolean;
  /** State of the authenticated viewer's latest submitted review */
  viewerLatestReviewState?: ViewerReviewState | null;
  starCount?: number;
  /** False when only light fields are loaded (phase 1); true/undefined when fully enriched */
  enriched?: boolean;
  /**
   * True when CI check status for the PR's current revision is unverified: set by
   * the lightweight backfill fallback (no check rollup), a failed fork rollup
   * lookup, or carried-forward enrichment whose revision changed or was already
   * stale. Cleared by a hot-poll status update or a successful backfill; while set, the PR is hot-polled
   * and approve/mergeable gating treats CI as unknown.
   */
  checkStatusStale?: boolean;
  /** GraphQL global node ID — used for hot-poll status updates */
  nodeId?: string;
  /** PR body — fetched on demand for dependency update type detection */
  body?: string;
  surfacedBy?: string[];
}

export interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  event: string;
  workflowId: number;
  headSha: string;
  headBranch: string;
  runNumber: number;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  repoFullName: string;
  isPrRun: boolean;
  runStartedAt: string;
  completedAt: string | null;
  runAttempt: number;
  displayTitle: string;
  actorLogin: string;
}

export interface ApiError {
  repo: string;
  statusCode: number | null;
  message: string;
  retryable: boolean;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAt: Date;
}

export interface DashboardSummary {
  openPRCount: number;
  openIssueCount: number;
  /** null when Actions monitoring is disabled */
  failingRunCount: number | null;
  needsReviewCount: number;
  approvedUnmergedCount: number;
}

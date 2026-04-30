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
}

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
}

export interface CheckStatus {
  status: "success" | "failure" | "pending" | "conflict" | null;
}

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
  starCount?: number;
  /** False when only light fields are loaded (phase 1); true/undefined when fully enriched */
  enriched?: boolean;
  /** GraphQL global node ID — used for hot-poll status updates */
  nodeId?: string;
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
  failingRunCount: number;
  needsReviewCount: number;
  approvedUnmergedCount: number;
}

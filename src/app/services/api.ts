import { getClient, cachedRequest, updateGraphqlRateLimit } from "./github";
import { pushNotification } from "../lib/errors";

// ── Types ────────────────────────────────────────────────────────────────────

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

export interface Issue {
  id: number;
  number: number;
  title: string;
  state: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  userLogin: string;
  userAvatarUrl: string;
  labels: { name: string; color: string }[];
  assigneeLogins: string[];
  repoFullName: string;
  comments: number;
}

export interface CheckStatus {
  status: "success" | "failure" | "pending" | null;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  state: string;
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

// ── Raw GitHub API shapes (minimal) ─────────────────────────────────────────

interface RawOrg {
  login: string;
  avatar_url: string;
  type?: string;
}

interface RawUser {
  login: string;
  avatar_url: string;
}

interface RawRepo {
  owner: { login: string };
  name: string;
  full_name: string;
  pushed_at: string | null;
}

interface RawWorkflowRun {
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
  completed_at: string | null;
  run_attempt: number;
  display_title: string;
  actor: { login: string } | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

// Batch repos into chunks for search queries (keeps URL length manageable)
const SEARCH_REPO_BATCH_SIZE = 30;

// Max fork PRs per GraphQL batch for the statusCheckRollup fallback query.
// Each alias looks up a single commit in the fork repo. Kept conservatively small
// to avoid hitting query complexity limits when many fork PRs need fallback.
const GRAPHQL_CHECK_BATCH_SIZE = 50;

// Repos confirmed to have zero workflow runs — skipped on subsequent polls.
// Persists across poll cycles; cleared on auth reset via resetEmptyActionRepos().
const _emptyActionRepos = new Set<string>();

export function resetEmptyActionRepos(): void {
  _emptyActionRepos.clear();
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Normalizes a Promise.allSettled rejection reason into a structured error shape.
 * Handles both Octokit RequestError (has `.status`) and plain Error objects.
 */
function extractRejectionError(reason: unknown): { statusCode: number | null; message: string } {
  const statusCode =
    typeof reason === "object" &&
    reason !== null &&
    "status" in reason &&
    typeof (reason as Record<string, unknown>)["status"] === "number"
      ? ((reason as Record<string, unknown>)["status"] as number)
      : null;
  const message = reason instanceof Error ? reason.message : String(reason);
  return { statusCode, message };
}

/**
 * Extracts partial data from a GraphqlResponseError (thrown when response contains both data and errors).
 * Returns the data if available, null otherwise.
 */
function extractGraphQLPartialData<T>(err: unknown): T | null {
  if (
    err &&
    typeof err === "object" &&
    "data" in err &&
    err.data &&
    typeof err.data === "object" &&
    "search" in err.data
  ) {
    return err.data as T;
  }
  return null;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

type GitHubOctokit = NonNullable<ReturnType<typeof getClient>>;

// ── GraphQL search types ─────────────────────────────────────────────────────

interface GraphQLIssueNode {
  databaseId: number;
  number: number;
  title: string;
  state: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string; avatarUrl: string } | null;
  labels: { nodes: { name: string; color: string }[] };
  assignees: { nodes: { login: string }[] };
  repository: { nameWithOwner: string } | null;
  comments: { totalCount: number };
}

interface GraphQLIssueSearchResponse {
  search: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (GraphQLIssueNode | null)[];
  };
  rateLimit?: { remaining: number; resetAt: string };
}

interface GraphQLPRNode {
  databaseId: number;
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  url: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string; avatarUrl: string } | null;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  headRepository: { owner: { login: string }; nameWithOwner: string } | null;
  repository: { nameWithOwner: string } | null;
  assignees: { nodes: { login: string }[] };
  reviewRequests: { nodes: { requestedReviewer: { login: string } | null }[] };
  labels: { nodes: { name: string; color: string }[] };
  additions: number;
  deletions: number;
  changedFiles: number;
  comments: { totalCount: number };
  reviewThreads: { totalCount: number };
  reviewDecision: string | null;
  latestReviews: {
    totalCount: number;
    nodes: { author: { login: string } | null }[];
  };
  commits: {
    nodes: {
      commit: {
        statusCheckRollup: { state: string } | null;
      };
    }[];
  };
}

interface GraphQLPRSearchResponse {
  search: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (GraphQLPRNode | null)[];
  };
  rateLimit?: { remaining: number; resetAt: string };
}

interface ForkCandidate {
  pr: PullRequest;
  headOwner: string;
  headRepo: string;
  sha: string;
}

interface ForkRepoResult {
  object: { statusCheckRollup: { state: string } | null } | null;
}

interface ForkQueryResponse {
  rateLimit?: { remaining: number; resetAt: string };
  [key: string]: ForkRepoResult | { remaining: number; resetAt: string } | undefined | null;
}

// ── GraphQL search query constants ───────────────────────────────────────────

const ISSUES_SEARCH_QUERY = `
  query($q: String!, $cursor: String) {
    search(query: $q, type: ISSUE, first: 100, after: $cursor) {
      issueCount
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on Issue {
          databaseId
          number
          title
          state
          url
          createdAt
          updatedAt
          author { login avatarUrl }
          labels(first: 20) { nodes { name color } }
          assignees(first: 20) { nodes { login } }
          repository { nameWithOwner }
          comments { totalCount }
        }
      }
    }
    rateLimit { remaining resetAt }
  }
`;

const PR_SEARCH_QUERY = `
  query($q: String!, $cursor: String) {
    # GitHub search API uses type: ISSUE for both issues and PRs
    search(query: $q, type: ISSUE, first: 100, after: $cursor) {
      issueCount
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on PullRequest {
          databaseId
          number
          title
          state
          isDraft
          url
          createdAt
          updatedAt
          author { login avatarUrl }
          headRefOid
          headRefName
          baseRefName
          headRepository { owner { login } nameWithOwner }
          repository { nameWithOwner }
          assignees(first: 20) { nodes { login } }
          reviewRequests(first: 20) {
            # Team reviewers are excluded (only User fragment matched)
            nodes { requestedReviewer { ... on User { login } } }
          }
          labels(first: 20) { nodes { name color } }
          additions
          deletions
          changedFiles
          comments { totalCount }
          reviewThreads { totalCount }
          reviewDecision
          latestReviews(first: 15) {
            totalCount
            nodes { author { login } }
          }
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup { state }
              }
            }
          }
        }
      }
    }
    rateLimit { remaining resetAt }
  }
`;

// ── GraphQL search functions ──────────────────────────────────────────────────

/**
 * Fetches open issues via GraphQL search, using cursor-based pagination.
 * Batches repos into chunks of SEARCH_REPO_BATCH_SIZE to keep query length safe.
 * Updates the GraphQL rate limit signal after each page.
 */
async function graphqlSearchIssues(
  octokit: GitHubOctokit,
  repos: RepoRef[],
  userLogin: string
): Promise<FetchIssuesResult> {
  const chunks = chunkArray(repos, SEARCH_REPO_BATCH_SIZE);
  const seen = new Set<number>();
  const issues: Issue[] = [];
  const errors: ApiError[] = [];

  let capReached = false;

  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    if (capReached) break;
    const chunk = chunks[chunkIdx];
    const repoQualifiers = chunk.map((r) => `repo:${r.fullName}`).join(" ");
    const queryString = `is:issue is:open involves:${userLogin} ${repoQualifiers}`;

    let cursor: string | null = null;

    while (true) {
      let response: GraphQLIssueSearchResponse;
      let isPartial = false;
      try {
        response = await octokit.graphql<GraphQLIssueSearchResponse>(
          ISSUES_SEARCH_QUERY,
          { q: queryString, cursor }
        );
      } catch (err) {
        // GraphqlResponseError contains partial data — extract valid nodes before recording error
        const partial = extractGraphQLPartialData<GraphQLIssueSearchResponse>(err);
        if (partial) {
          response = partial;
          isPartial = true;
          const { message } = extractRejectionError(err);
          errors.push({
            repo: `search-batch-${chunkIdx + 1}/${chunks.length}`,
            statusCode: null,
            message,
            retryable: true,
          });
        } else {
          const { statusCode, message } = extractRejectionError(err);
          errors.push({
            repo: `search-batch-${chunkIdx + 1}/${chunks.length}`,
            statusCode,
            message,
            retryable: statusCode === null || statusCode >= 500,
          });
          break;
        }
      }

      if (response.rateLimit) updateGraphqlRateLimit(response.rateLimit);

      for (const node of response.search.nodes) {
        if (!node || node.databaseId == null || !node.repository) continue;
        if (seen.has(node.databaseId)) continue;
        seen.add(node.databaseId);
        issues.push({
          id: node.databaseId,
          number: node.number,
          title: node.title,
          state: node.state,
          htmlUrl: node.url,
          createdAt: node.createdAt,
          updatedAt: node.updatedAt,
          userLogin: node.author?.login ?? "",
          userAvatarUrl: node.author?.avatarUrl ?? "",
          labels: node.labels.nodes.map((l) => ({ name: l.name, color: l.color })),
          assigneeLogins: node.assignees.nodes.map((a) => a.login),
          repoFullName: node.repository.nameWithOwner,
          comments: node.comments.totalCount,
        });
      }

      // Don't paginate after partial error — pageInfo may be unreliable
      if (isPartial) break;

      if (issues.length >= 1000 && !capReached) {
        capReached = true;
        const total = response.search.issueCount;
        console.warn(`[api] Issue search results capped at 1000 (${total} total)`);
        pushNotification(
          "search/issues",
          `Issue search results capped at 1,000 of ${total.toLocaleString()} total — some items are hidden`,
          "warning"
        );
        break;
      }

      if (!response.search.pageInfo.hasNextPage || !response.search.pageInfo.endCursor) break;
      cursor = response.search.pageInfo.endCursor;
    }
  }

  return { issues, errors };
}

/**
 * Maps a GraphQL statusCheckRollup state string to the app's CheckStatus type.
 */
function mapCheckStatus(state: string | null | undefined): CheckStatus["status"] {
  if (state === "FAILURE" || state === "ERROR") return "failure";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  if (state === "SUCCESS") return "success";
  return null;
}

/**
 * Maps a GraphQL reviewDecision string to the typed union or null.
 */
function mapReviewDecision(
  raw: string | null | undefined
): "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null {
  if (
    raw === "APPROVED" ||
    raw === "CHANGES_REQUESTED" ||
    raw === "REVIEW_REQUIRED"
  ) {
    return raw;
  }
  return null;
}

/**
 * Fetches open PRs via GraphQL search with two queries (involves + review-requested),
 * deduplicates by databaseId, and handles fork PR statusCheckRollup fallback.
 */
async function graphqlSearchPRs(
  octokit: GitHubOctokit,
  repos: RepoRef[],
  userLogin: string
): Promise<FetchPullRequestsResult> {
  const chunks = chunkArray(repos, SEARCH_REPO_BATCH_SIZE);
  const prMap = new Map<number, PullRequest>();
  // Side-channel: store headRepository info for fork detection
  const headRepoInfoMap = new Map<number, { owner: string; repoName: string } | null>();
  const errors: ApiError[] = [];
  let prCapReached = false;

  // Run involves and review-requested searches across all repo chunks
  for (const queryType of [
    `is:pr is:open involves:${userLogin}`,
    `is:pr is:open review-requested:${userLogin}`,
  ]) {
    if (prCapReached) break;
    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      if (prCapReached) break;
      const chunk = chunks[chunkIdx];
      const repoQualifiers = chunk.map((r) => `repo:${r.fullName}`).join(" ");
      const queryString = `${queryType} ${repoQualifiers}`;

      let cursor: string | null = null;

      while (true) {
        let response: GraphQLPRSearchResponse;
        let isPartial = false;
        try {
          response = await octokit.graphql<GraphQLPRSearchResponse>(
            PR_SEARCH_QUERY,
            { q: queryString, cursor }
          );
        } catch (err) {
          const partial = extractGraphQLPartialData<GraphQLPRSearchResponse>(err);
          if (partial) {
            response = partial;
            isPartial = true;
            const { message } = extractRejectionError(err);
            errors.push({
              repo: `pr-search-batch-${chunkIdx + 1}/${chunks.length}`,
              statusCode: null,
              message,
              retryable: true,
            });
          } else {
            const { statusCode, message } = extractRejectionError(err);
            errors.push({
              repo: `pr-search-batch-${chunkIdx + 1}/${chunks.length}`,
              statusCode,
              message,
              retryable: statusCode === null || statusCode >= 500,
            });
            break;
          }
        }

        if (response.rateLimit) updateGraphqlRateLimit(response.rateLimit);

        for (const node of response.search.nodes) {
          if (!node || node.databaseId == null || !node.repository) continue;
          if (prMap.has(node.databaseId)) continue;

          const pendingLogins = node.reviewRequests.nodes
            .map((n) => n.requestedReviewer?.login)
            .filter((l): l is string => l != null);
          const actualLogins = node.latestReviews.nodes
            .map((n) => n.author?.login)
            .filter((l): l is string => l != null);
          // Normalize logins to lowercase to avoid case-sensitive duplicates
          const reviewerLogins = [...new Set([...pendingLogins, ...actualLogins].map(l => l.toLowerCase()))];

          const rawState =
            node.commits.nodes[0]?.commit?.statusCheckRollup?.state ?? null;
          const checkStatus = mapCheckStatus(rawState);

          // Store headRepository info for fork detection
          if (node.headRepository) {
            const parts = node.headRepository.nameWithOwner.split("/");
            if (parts.length === 2) {
              headRepoInfoMap.set(node.databaseId, {
                owner: node.headRepository.owner.login,
                repoName: parts[1],
              });
            } else {
              // Malformed nameWithOwner — treat as deleted fork (no fallback)
              headRepoInfoMap.set(node.databaseId, null);
            }
          } else {
            headRepoInfoMap.set(node.databaseId, null);
          }

          prMap.set(node.databaseId, {
            id: node.databaseId,
            number: node.number,
            title: node.title,
            state: node.state,
            draft: node.isDraft,
            htmlUrl: node.url,
            createdAt: node.createdAt,
            updatedAt: node.updatedAt,
            userLogin: node.author?.login ?? "",
            userAvatarUrl: node.author?.avatarUrl ?? "",
            headSha: node.headRefOid,
            headRef: node.headRefName,
            baseRef: node.baseRefName,
            assigneeLogins: node.assignees.nodes.map((a) => a.login),
            reviewerLogins,
            repoFullName: node.repository.nameWithOwner,
            checkStatus,
            additions: node.additions,
            deletions: node.deletions,
            changedFiles: node.changedFiles,
            comments: node.comments.totalCount,
            reviewThreads: node.reviewThreads.totalCount,
            labels: node.labels.nodes.map((l) => ({ name: l.name, color: l.color })),
            reviewDecision: mapReviewDecision(node.reviewDecision),
            totalReviewCount: node.latestReviews.totalCount,
          });
        }

        // Don't paginate after partial error — pageInfo may be unreliable
        if (isPartial) break;

        if (prMap.size >= 1000 && !prCapReached) {
          prCapReached = true;
          const total = response.search.issueCount;
          console.warn(`[api] PR search results capped at 1000 (${total} total)`);
          pushNotification(
            "search/prs",
            `PR search results capped at 1,000 of ${total.toLocaleString()} total — some items are hidden`,
            "warning"
          );
          break;
        }

        if (!response.search.pageInfo.hasNextPage || !response.search.pageInfo.endCursor) break;
        cursor = response.search.pageInfo.endCursor;
      }
    }
  }

  // Fork PR fallback: for PRs where checkStatus is null AND headRepository owner
  // differs from base repo owner, query the head repo's commit statusCheckRollup.
  // GitHub copies fork PR commits into base repo (refs/pull/N/head), so most PRs
  // resolve via the base repo. The fallback handles cases where CI runs only on the fork.
  const forkCandidates: ForkCandidate[] = [];

  for (const [databaseId, pr] of prMap) {
    if (pr.checkStatus !== null) continue; // already resolved
    const headInfo = headRepoInfoMap.get(databaseId);
    if (!headInfo) continue; // null headRepository — deleted fork, skip
    const baseOwner = pr.repoFullName.split("/")[0].toLowerCase();
    if (headInfo.owner.toLowerCase() === baseOwner) continue; // not a fork
    forkCandidates.push({ pr, headOwner: headInfo.owner, headRepo: headInfo.repoName, sha: pr.headSha });
  }

  if (forkCandidates.length > 0) {
    const forkChunks = chunkArray(forkCandidates, GRAPHQL_CHECK_BATCH_SIZE);
    for (const forkChunk of forkChunks) {
      const varDefs: string[] = [];
      const variables: Record<string, string> = {};
      const fragments: string[] = [];

      for (let i = 0; i < forkChunk.length; i++) {
        varDefs.push(`$owner${i}: String!`, `$repo${i}: String!`, `$sha${i}: String!`);
        variables[`owner${i}`] = forkChunk[i].headOwner;
        variables[`repo${i}`] = forkChunk[i].headRepo;
        variables[`sha${i}`] = forkChunk[i].sha;
        fragments.push(
          `fork${i}: repository(owner: $owner${i}, name: $repo${i}) {
            object(expression: $sha${i}) {
              ... on Commit {
                statusCheckRollup { state }
              }
            }
          }`
        );
      }

      const forkQuery = `query(${varDefs.join(", ")}) {\n${fragments.join("\n")}\nrateLimit { remaining resetAt }\n}`;

      try {
        const forkResponse = await octokit.graphql<ForkQueryResponse>(forkQuery, variables);
        if (forkResponse.rateLimit) updateGraphqlRateLimit(forkResponse.rateLimit as { remaining: number; resetAt: string });

        for (let i = 0; i < forkChunk.length; i++) {
          const data = forkResponse[`fork${i}`] as ForkRepoResult | null | undefined;
          const state = data?.object?.statusCheckRollup?.state ?? null;
          const candidate = forkChunk[i];
          const pr = prMap.get(candidate.pr.id);
          if (pr) {
            pr.checkStatus = mapCheckStatus(state);
          }
        }
      } catch (err) {
        console.warn("[api] Fork PR statusCheckRollup fallback failed:", err);
        pushNotification(
          "graphql",
          "Fork PR check status unavailable — CI status may be missing for some PRs",
          "warning"
        );
        // Leave checkStatus as null for affected PRs — degraded, not broken
      }
    }
  }

  const pullRequests = [...prMap.values()];
  return { pullRequests, errors };
}

// ── Step 1: fetchOrgs ────────────────────────────────────────────────────────

/**
 * Returns orgs and the personal user account. Personal account is first.
 */
export async function fetchOrgs(
  octokit: ReturnType<typeof getClient>
): Promise<OrgEntry[]> {
  if (!octokit) throw new Error("No GitHub client available");

  const [userResult, orgsResult] = await Promise.all([
    cachedRequest(octokit, "orgs:user", "GET /user"),
    cachedRequest(octokit, "orgs:all", "GET /user/orgs", { per_page: 100 }),
  ]);

  const user = userResult.data as RawUser;
  const orgs = orgsResult.data as RawOrg[];

  const personal: OrgEntry = {
    login: user.login,
    avatarUrl: user.avatar_url,
    type: "user",
  };

  const orgEntries: OrgEntry[] = orgs.map((o) => ({
    login: o.login,
    avatarUrl: o.avatar_url,
    type: "org",
  }));

  return [personal, ...orgEntries];
}

// ── Step 2: fetchRepos ───────────────────────────────────────────────────────

/**
 * Fetches all repos for a given org or user (personal account).
 * Uses paginate.iterator for lazy loading.
 */
export async function fetchRepos(
  octokit: ReturnType<typeof getClient>,
  orgOrUser: string,
  type: "org" | "user"
): Promise<RepoEntry[]> {
  if (!octokit) throw new Error("No GitHub client available");

  const repos: RepoEntry[] = [];

  if (type === "org") {
    for await (const response of octokit.paginate.iterator(`GET /orgs/{org}/repos`, {
      org: orgOrUser,
      per_page: 100,
      sort: "pushed" as const,
      direction: "desc" as const,
    })) {
      for (const repo of response.data as RawRepo[]) {
        repos.push({ owner: repo.owner.login, name: repo.name, fullName: repo.full_name, pushedAt: repo.pushed_at ?? null });
      }
    }
  } else {
    for await (const response of octokit.paginate.iterator(`GET /user/repos`, {
      affiliation: "owner",
      per_page: 100,
      sort: "pushed" as const,
      direction: "desc" as const,
    })) {
      for (const repo of response.data as RawRepo[]) {
        repos.push({ owner: repo.owner.login, name: repo.name, fullName: repo.full_name, pushedAt: repo.pushed_at ?? null });
      }
    }
  }

  return repos;
}

// ── Step 3: fetchIssues (GraphQL Search) ─────────────────────────────────────

/**
 * Fetches open issues across repos where the user is involved (author, assignee,
 * mentioned, or commenter) using GraphQL search queries, batched in chunks of 30 repos.
 */
export interface FetchIssuesResult {
  issues: Issue[];
  errors: ApiError[];
}

export async function fetchIssues(
  octokit: ReturnType<typeof getClient>,
  repos: RepoRef[],
  userLogin: string
): Promise<FetchIssuesResult> {
  if (!octokit) throw new Error("No GitHub client available");
  if (repos.length === 0 || !userLogin) return { issues: [], errors: [] };
  return graphqlSearchIssues(octokit, repos, userLogin);
}

// ── Step 4: fetchPullRequests (GraphQL search) ───────────────────────────────

export interface FetchPullRequestsResult {
  pullRequests: PullRequest[];
  errors: ApiError[];
}

export async function fetchPullRequests(
  octokit: ReturnType<typeof getClient>,
  repos: RepoRef[],
  userLogin: string
): Promise<FetchPullRequestsResult> {
  if (!octokit) throw new Error("No GitHub client available");
  if (repos.length === 0 || !userLogin) return { pullRequests: [], errors: [] };
  return graphqlSearchPRs(octokit, repos, userLogin);
}

// ── Step 5: fetchWorkflowRuns (single endpoint per repo) ─────────────────────

/**
 * Fetches recent workflow runs per repo using a single API call per repo
 * instead of listing workflows first then fetching runs per workflow.
 *
 * Before: 1 call (workflow list) + N calls (runs per workflow) = 1+N per repo.
 * After:  1 call per repo (GET /repos/{owner}/{repo}/actions/runs).
 *
 * Groups runs by workflow_id client-side and applies maxWorkflows/maxRuns limits.
 */
export interface FetchWorkflowRunsResult {
  workflowRuns: WorkflowRun[];
  errors: ApiError[];
}

export async function fetchWorkflowRuns(
  octokit: ReturnType<typeof getClient>,
  repos: RepoRef[],
  maxWorkflows: number,
  maxRuns: number
): Promise<FetchWorkflowRunsResult> {
  if (!octokit) throw new Error("No GitHub client available");

  const allRuns: WorkflowRun[] = [];
  const allErrors: ApiError[] = [];

  // We need enough runs to cover maxWorkflows × maxRuns per repo.
  // Request only what we need — per_page sized to target + small buffer.
  const targetRunsPerRepo = maxWorkflows * maxRuns;
  const perPage = Math.min(Math.max(targetRunsPerRepo + 5, 20), 100);

  const RUNS_CONCURRENCY = 10;
  const repoChunks = chunkArray(repos, RUNS_CONCURRENCY);
  for (const chunk of repoChunks) {
    const chunkResults = await Promise.allSettled(chunk.map(async (repo) => {
    // Skip repos known to have zero workflow runs (cached empty result)
    if (_emptyActionRepos.has(repo.fullName)) return;

    const rawRuns: RawWorkflowRun[] = [];
    let page = 1;

    // Paginate until we have enough runs or exhaust results
    while (rawRuns.length < targetRunsPerRepo) {
      const result = await cachedRequest(
        octokit,
        `runs:${repo.fullName}:p${page}`,
        "GET /repos/{owner}/{repo}/actions/runs",
        { owner: repo.owner, repo: repo.name, per_page: perPage, page }
      );

      const data = result.data as {
        workflow_runs: RawWorkflowRun[];
        total_count: number;
      };
      const runs = data.workflow_runs ?? [];
      rawRuns.push(...runs);

      // Stop if we got all runs or this page was short
      if (rawRuns.length >= data.total_count || runs.length < perPage) break;
      page++;
    }

    // Cache repos with zero runs — skip them on subsequent polls
    if (rawRuns.length === 0) {
      _emptyActionRepos.add(repo.fullName);
      return;
    }

    // Group by workflow_id
    const byWorkflow = new Map<number, RawWorkflowRun[]>();
    for (const run of rawRuns) {
      let group = byWorkflow.get(run.workflow_id);
      if (!group) {
        group = [];
        byWorkflow.set(run.workflow_id, group);
      }
      group.push(run);
    }

    // Sort workflows by most recent run, take top N
    const workflowEntries = [...byWorkflow.entries()].map(([id, runs]) => ({
      id,
      runs,
      latestAt: runs.reduce((max, r) => r.updated_at > max ? r.updated_at : max, ""),
    }));
    workflowEntries.sort((a, b) => a.latestAt > b.latestAt ? -1 : a.latestAt < b.latestAt ? 1 : 0);
    // Take most recent M runs per workflow
    for (const { runs: workflowRuns } of workflowEntries.slice(0, maxWorkflows)) {
      const sorted = workflowRuns.sort(
        (a, b) => a.created_at > b.created_at ? -1 : a.created_at < b.created_at ? 1 : 0
      );
      for (const run of sorted.slice(0, maxRuns)) {
        allRuns.push({
          id: run.id,
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
          event: run.event,
          workflowId: run.workflow_id,
          headSha: run.head_sha,
          headBranch: run.head_branch,
          runNumber: run.run_number,
          htmlUrl: run.html_url,
          createdAt: run.created_at,
          updatedAt: run.updated_at,
          repoFullName: repo.fullName,
          isPrRun: run.event === "pull_request",
          runStartedAt: run.run_started_at,
          completedAt: run.completed_at ?? null,
          runAttempt: run.run_attempt,
          displayTitle: run.display_title,
          actorLogin: run.actor?.login ?? "",
        });
      }
    }
  }));

    for (const result of chunkResults) {
      if (result.status === "rejected") {
        const { statusCode, message } = extractRejectionError(result.reason);
        allErrors.push({ repo: "workflow-runs", statusCode, message, retryable: true });
      }
    }
  }

  return { workflowRuns: allRuns, errors: allErrors };
}

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
  status: "success" | "failure" | "pending" | "conflict" | null;
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

// Batch repos into chunks for search queries (keeps URL length manageable).
// 50 repos keeps query strings well within GitHub's limits (qualifiers like repo:
// are excluded from the 256-char search term cap) while reducing HTTP round-trips.
const SEARCH_REPO_BATCH_SIZE = 50;

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
 * Extracts partial data from a GraphqlResponseError for search queries.
 * Only matches responses containing a `search` key (issues/PRs search shape).
 */
function extractSearchPartialData<T>(err: unknown): T | null {
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

const VALID_REPO_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const VALID_LOGIN = /^[A-Za-z0-9\[\]-]+$/;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

type GitHubOctokit = NonNullable<ReturnType<typeof getClient>>;

/**
 * Runs an array of async task factories with bounded concurrency.
 * Unlike chunked Promise.allSettled, tasks start immediately as slots free up
 * rather than waiting for an entire chunk to finish.
 */
async function pooledAllSettled<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++;
      try {
        results[idx] = { status: "fulfilled", value: await tasks[idx]() };
      } catch (reason) {
        results[idx] = { status: "rejected", reason };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => runWorker()
  );
  await Promise.all(workers);
  return results;
}

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
  mergeStateStatus: string;
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
  databaseId: number;
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
          mergeStateStatus
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

// ── GraphQL combined search query ─────────────────────────────────────────────

const PR_FRAGMENT = `
  fragment PRSearchFields on PullRequest {
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
    mergeStateStatus
    assignees(first: 20) { nodes { login } }
    reviewRequests(first: 20) {
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
`;

/**
 * Combined query that fetches issues, PR-involves, and PR-review-requested
 * in a single HTTP request using GraphQL aliases. Each alias has its own
 * cursor for independent pagination.
 */
const COMBINED_SEARCH_QUERY = `
  query($issueQ: String!, $prInvQ: String!, $prRevQ: String!,
        $issueCursor: String, $prInvCursor: String, $prRevCursor: String) {
    issues: search(query: $issueQ, type: ISSUE, first: 100, after: $issueCursor) {
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
    prInvolves: search(query: $prInvQ, type: ISSUE, first: 100, after: $prInvCursor) {
      issueCount
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on PullRequest {
          ...PRSearchFields
        }
      }
    }
    prReviewReq: search(query: $prRevQ, type: ISSUE, first: 100, after: $prRevCursor) {
      issueCount
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on PullRequest {
          ...PRSearchFields
        }
      }
    }
    rateLimit { remaining resetAt }
  }
  ${PR_FRAGMENT}
`;

interface CombinedSearchResponse {
  issues: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (GraphQLIssueNode | null)[];
  };
  prInvolves: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (GraphQLPRNode | null)[];
  };
  prReviewReq: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (GraphQLPRNode | null)[];
  };
  rateLimit?: { remaining: number; resetAt: string };
}

// ── GraphQL search functions ──────────────────────────────────────────────────

interface SearchPageResult<T> {
  issueCount: number;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: (T | null)[];
}

/**
 * Paginates a single GraphQL search query string, collecting results via a
 * caller-provided `processNode` callback. Handles partial errors, cap enforcement,
 * and rate limit tracking. Returns the count of items added by processNode.
 */
async function paginateGraphQLSearch<TResponse extends { search: SearchPageResult<TNode>; rateLimit?: { remaining: number; resetAt: string } }, TNode>(
  octokit: GitHubOctokit,
  query: string,
  queryString: string,
  batchLabel: string,
  errors: ApiError[],
  processNode: (node: TNode) => boolean, // returns true if node was added (for cap counting)
  currentCount: () => number,
  cap: number,
  startCursor?: string | null,
): Promise<{ capReached: boolean }> {
  let cursor: string | null = startCursor ?? null;
  let capReached = false;

  while (true) {
    try {
      let response: TResponse;
      let isPartial = false;
      try {
        response = await octokit.graphql<TResponse>(query, { q: queryString, cursor });
      } catch (err) {
        const partial = extractSearchPartialData<TResponse>(err);
        if (partial) {
          response = partial;
          isPartial = true;
          const { message } = extractRejectionError(err);
          errors.push({ repo: batchLabel, statusCode: null, message, retryable: true });
        } else {
          const { statusCode, message } = extractRejectionError(err);
          errors.push({
            repo: batchLabel,
            statusCode,
            message,
            retryable: statusCode === null || statusCode >= 500,
          });
          break;
        }
      }

      if (response.rateLimit) updateGraphqlRateLimit(response.rateLimit);

      for (const node of response.search.nodes) {
        if (currentCount() >= cap) {
          capReached = true;
          break;
        }
        if (!node) continue;
        processNode(node);
      }

      if (capReached) {
        return { capReached: true };
      }

      if (isPartial) break;

      if (currentCount() >= cap) {
        return { capReached: true };
      }

      if (!response.search.pageInfo.hasNextPage || !response.search.pageInfo.endCursor) break;
      cursor = response.search.pageInfo.endCursor;
    } catch (err) {
      const { message } = extractRejectionError(err);
      errors.push({ repo: batchLabel, statusCode: null, message, retryable: false });
      break;
    }
  }

  return { capReached };
}

function buildRepoQualifiers(repos: RepoRef[]): string {
  return repos
    .filter((r) => VALID_REPO_NAME.test(r.fullName))
    .map((r) => `repo:${r.fullName}`)
    .join(" ");
}

/**
 * Processes a single GraphQL issue node into the app's Issue shape.
 * Returns true if the node was added (not a duplicate or invalid).
 */
function processIssueNode(
  node: GraphQLIssueNode,
  seen: Set<number>,
  issues: Issue[]
): boolean {
  if (node.databaseId == null || !node.repository) return false;
  if (seen.has(node.databaseId)) return false;
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
  return true;
}

/**
 * Processes a single GraphQL PR node into the app's PullRequest shape.
 * Returns true if the node was added (not a duplicate or invalid).
 */
function processPRNodeShared(
  node: GraphQLPRNode,
  prMap: Map<number, PullRequest>,
  forkInfoMap: Map<number, { owner: string; repoName: string }>
): boolean {
  if (node.databaseId == null || !node.repository) return false;
  if (prMap.has(node.databaseId)) return false;

  const pendingLogins = node.reviewRequests.nodes
    .map((n) => n.requestedReviewer?.login)
    .filter((l): l is string => l != null);
  const actualLogins = node.latestReviews.nodes
    .map((n) => n.author?.login)
    .filter((l): l is string => l != null);
  const reviewerLogins = [...new Set([...pendingLogins, ...actualLogins].map(l => l.toLowerCase()))];

  let checkStatus = mapCheckStatus(node.commits.nodes[0]?.commit?.statusCheckRollup?.state ?? null);
  const mss = node.mergeStateStatus;
  if (mss === "DIRTY" || mss === "BEHIND") {
    checkStatus = "conflict";
  } else if (mss === "UNSTABLE") {
    checkStatus = "failure";
  } else if (mss === "UNKNOWN" && checkStatus === null) {
    checkStatus = null;
  }

  if (node.headRepository) {
    const parts = node.headRepository.nameWithOwner.split("/");
    if (parts.length === 2) {
      forkInfoMap.set(node.databaseId, { owner: node.headRepository.owner.login, repoName: parts[1] });
    }
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
  return true;
}

/**
 * Runs the fork PR statusCheckRollup fallback for PRs where head repo owner
 * differs from base repo owner (fork PRs). Mutates prMap in place.
 */
async function runForkPRFallback(
  octokit: GitHubOctokit,
  prMap: Map<number, PullRequest>,
  forkInfoMap: Map<number, { owner: string; repoName: string }>
): Promise<void> {
  const forkCandidates: ForkCandidate[] = [];
  for (const [databaseId, pr] of prMap) {
    if (pr.checkStatus !== null) continue;
    const headInfo = forkInfoMap.get(databaseId);
    if (!headInfo) continue;
    const baseOwner = pr.repoFullName.split("/")[0].toLowerCase();
    if (headInfo.owner.toLowerCase() === baseOwner) continue;
    forkCandidates.push({ databaseId, headOwner: headInfo.owner, headRepo: headInfo.repoName, sha: pr.headSha });
  }

  if (forkCandidates.length === 0) return;

  const forkChunks = chunkArray(forkCandidates, GRAPHQL_CHECK_BATCH_SIZE);
  await Promise.allSettled(forkChunks.map(async (forkChunk) => {
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
        const pr = prMap.get(forkChunk[i].databaseId);
        if (pr) pr.checkStatus = mapCheckStatus(state);
      }
    } catch (err) {
      const partialData = (err && typeof err === "object" && "data" in err && err.data && typeof err.data === "object")
        ? err.data as Record<string, ForkRepoResult | null | undefined>
        : null;

      if (partialData) {
        for (let i = 0; i < forkChunk.length; i++) {
          const data = partialData[`fork${i}`];
          if (!data) continue;
          const state = data.object?.statusCheckRollup?.state ?? null;
          const pr = prMap.get(forkChunk[i].databaseId);
          if (pr) pr.checkStatus = mapCheckStatus(state);
        }
      }

      console.warn("[api] Fork PR statusCheckRollup fallback partially failed:", err);
      pushNotification("graphql", "Fork PR check status unavailable — CI status may be missing for some PRs", "warning");
    }
  }));
}

// ── Combined search (issues + PRs in single request) ─────────────────────────

export interface FetchIssuesAndPRsResult {
  issues: Issue[];
  pullRequests: PullRequest[];
  errors: ApiError[];
}

/**
 * Fetches issues and PRs via a single aliased GraphQL query per repo chunk.
 * Combines issue search, PR-involves, and PR-review-requested into one HTTP call,
 * reducing round-trips by ~66%. Falls back to individual pagination queries if
 * any alias needs additional pages.
 */
async function graphqlCombinedSearch(
  octokit: GitHubOctokit,
  repos: RepoRef[],
  userLogin: string
): Promise<FetchIssuesAndPRsResult> {
  if (!VALID_LOGIN.test(userLogin)) {
    return {
      issues: [],
      pullRequests: [],
      errors: [{ repo: "search", statusCode: null, message: "Invalid userLogin", retryable: false }],
    };
  }

  const chunks = chunkArray(repos, SEARCH_REPO_BATCH_SIZE);
  const issueSeen = new Set<number>();
  const issues: Issue[] = [];
  const prMap = new Map<number, PullRequest>();
  const forkInfoMap = new Map<number, { owner: string; repoName: string }>();
  const errors: ApiError[] = [];
  const ISSUE_CAP = 1000;
  const PR_CAP = 1000;

  const chunkResults = await Promise.allSettled(chunks.map(async (chunk, chunkIdx) => {
    const repoQualifiers = buildRepoQualifiers(chunk);
    const issueQ = `is:issue is:open involves:${userLogin} ${repoQualifiers}`;
    const prInvQ = `is:pr is:open involves:${userLogin} ${repoQualifiers}`;
    const prRevQ = `is:pr is:open review-requested:${userLogin} ${repoQualifiers}`;
    const batchLabel = `combined-batch-${chunkIdx + 1}/${chunks.length}`;

    // Fire the combined 3-alias query
    let response: CombinedSearchResponse;
    let isPartial = false;
    try {
      try {
        response = await octokit.graphql<CombinedSearchResponse>(COMBINED_SEARCH_QUERY, {
          issueQ, prInvQ, prRevQ,
          issueCursor: null, prInvCursor: null, prRevCursor: null,
        });
      } catch (err) {
        // Try to extract partial data from GraphqlResponseError
        const partial = (err && typeof err === "object" && "data" in err && err.data && typeof err.data === "object")
          ? err.data as Partial<CombinedSearchResponse>
          : null;
        if (partial && (partial.issues || partial.prInvolves || partial.prReviewReq)) {
          response = {
            issues: partial.issues ?? { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            prInvolves: partial.prInvolves ?? { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            prReviewReq: partial.prReviewReq ?? { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            rateLimit: partial.rateLimit,
          };
          isPartial = true;
          const { message } = extractRejectionError(err);
          errors.push({ repo: batchLabel, statusCode: null, message, retryable: true });
        } else {
          throw err;
        }
      }

      if (response.rateLimit) updateGraphqlRateLimit(response.rateLimit);

      // Process issue nodes
      for (const node of response.issues.nodes) {
        if (issues.length >= ISSUE_CAP) break;
        if (!node) continue;
        processIssueNode(node, issueSeen, issues);
      }

      // Process PR nodes from both aliases
      for (const node of response.prInvolves.nodes) {
        if (prMap.size >= PR_CAP) break;
        if (!node) continue;
        processPRNodeShared(node, prMap, forkInfoMap);
      }
      for (const node of response.prReviewReq.nodes) {
        if (prMap.size >= PR_CAP) break;
        if (!node) continue;
        processPRNodeShared(node, prMap, forkInfoMap);
      }

      // If partial error, skip pagination for this chunk
      if (isPartial) return;

      // Pagination follow-ups: for any alias with hasNextPage, fall back to
      // individual search queries using the existing paginateGraphQLSearch.
      const paginationTasks: Promise<unknown>[] = [];

      if (response.issues.pageInfo.hasNextPage && response.issues.pageInfo.endCursor && issues.length < ISSUE_CAP) {
        paginationTasks.push(paginateGraphQLSearch<GraphQLIssueSearchResponse, GraphQLIssueNode>(
          octokit, ISSUES_SEARCH_QUERY, issueQ, batchLabel, errors,
          (node) => processIssueNode(node, issueSeen, issues),
          () => issues.length, ISSUE_CAP, response.issues.pageInfo.endCursor,
        ));
      }

      if (response.prInvolves.pageInfo.hasNextPage && response.prInvolves.pageInfo.endCursor && prMap.size < PR_CAP) {
        paginationTasks.push(paginateGraphQLSearch<GraphQLPRSearchResponse, GraphQLPRNode>(
          octokit, PR_SEARCH_QUERY, prInvQ, batchLabel, errors,
          (node) => processPRNodeShared(node, prMap, forkInfoMap),
          () => prMap.size, PR_CAP, response.prInvolves.pageInfo.endCursor,
        ));
      }

      if (response.prReviewReq.pageInfo.hasNextPage && response.prReviewReq.pageInfo.endCursor && prMap.size < PR_CAP) {
        paginationTasks.push(paginateGraphQLSearch<GraphQLPRSearchResponse, GraphQLPRNode>(
          octokit, PR_SEARCH_QUERY, prRevQ, batchLabel, errors,
          (node) => processPRNodeShared(node, prMap, forkInfoMap),
          () => prMap.size, PR_CAP, response.prReviewReq.pageInfo.endCursor,
        ));
      }

      if (paginationTasks.length > 0) {
        await Promise.allSettled(paginationTasks);
      }
    } catch (err) {
      const { statusCode, message } = extractRejectionError(err);
      errors.push({ repo: batchLabel, statusCode, message, retryable: statusCode === null || statusCode >= 500 });
    }
  }));

  for (const result of chunkResults) {
    if (result.status === "rejected") {
      const { statusCode, message } = extractRejectionError(result.reason);
      errors.push({ repo: "combined-batch", statusCode, message, retryable: statusCode === null || statusCode >= 500 });
    }
  }

  // Cap enforcement
  if (issues.length >= ISSUE_CAP) {
    console.warn(`[api] Issue search results capped at ${ISSUE_CAP}`);
    pushNotification("search/issues", `Issue search results capped at 1,000 — some items are hidden`, "warning");
    issues.splice(ISSUE_CAP);
  }

  if (prMap.size >= PR_CAP) {
    console.warn(`[api] PR search results capped at ${PR_CAP}`);
    pushNotification("search/prs", `PR search results capped at 1,000 — some items are hidden`, "warning");
  }

  // Fork PR fallback
  await runForkPRFallback(octokit, prMap, forkInfoMap);

  const pullRequests = [...prMap.values()];
  if (pullRequests.length >= PR_CAP) pullRequests.splice(PR_CAP);

  return { issues, pullRequests, errors };
}

/**
 * Fetches open issues and PRs together using a combined aliased GraphQL query.
 * This reduces HTTP round-trips by ~66% compared to separate fetchIssues/fetchPullRequests.
 */
export async function fetchIssuesAndPullRequests(
  octokit: ReturnType<typeof getClient>,
  repos: RepoRef[],
  userLogin: string
): Promise<FetchIssuesAndPRsResult> {
  if (!octokit) throw new Error("No GitHub client available");
  if (repos.length === 0 || !userLogin) return { issues: [], pullRequests: [], errors: [] };
  return graphqlCombinedSearch(octokit, repos, userLogin);
}

/**
 * Fetches open issues via GraphQL search, using cursor-based pagination.
 * Batches repos into chunks of SEARCH_REPO_BATCH_SIZE and runs chunks in parallel.
 */
async function graphqlSearchIssues(
  octokit: GitHubOctokit,
  repos: RepoRef[],
  userLogin: string
): Promise<FetchIssuesResult> {
  if (!VALID_LOGIN.test(userLogin)) return { issues: [], errors: [{ repo: "search", statusCode: null, message: "Invalid userLogin", retryable: false }] };

  const chunks = chunkArray(repos, SEARCH_REPO_BATCH_SIZE);
  const seen = new Set<number>();
  const issues: Issue[] = [];
  const errors: ApiError[] = [];
  const CAP = 1000;

  const chunkResults = await Promise.allSettled(chunks.map(async (chunk, chunkIdx) => {
    const repoQualifiers = buildRepoQualifiers(chunk);
    const queryString = `is:issue is:open involves:${userLogin} ${repoQualifiers}`;

    await paginateGraphQLSearch<GraphQLIssueSearchResponse, GraphQLIssueNode>(
      octokit, ISSUES_SEARCH_QUERY, queryString,
      `search-batch-${chunkIdx + 1}/${chunks.length}`,
      errors,
      (node) => {
        if (node.databaseId == null || !node.repository) return false;
        if (seen.has(node.databaseId)) return false;
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
        return true;
      },
      () => issues.length,
      CAP,
    );
  }));

  for (const result of chunkResults) {
    if (result.status === "rejected") {
      const { statusCode, message } = extractRejectionError(result.reason);
      errors.push({ repo: "search-batch", statusCode, message, retryable: statusCode === null || statusCode >= 500 });
    }
  }

  if (issues.length >= CAP) {
    console.warn(`[api] Issue search results capped at ${CAP}`);
    pushNotification("search/issues", `Issue search results capped at 1,000 — some items are hidden`, "warning");
    issues.splice(CAP);
  }

  return { issues, errors };
}

/**
 * Maps a GraphQL statusCheckRollup state string to the app's CheckStatus type.
 */
function mapCheckStatus(state: string | null | undefined): CheckStatus["status"] {
  if (state === "FAILURE" || state === "ERROR" || state === "ACTION_REQUIRED") return "failure";
  if (state === "PENDING" || state === "EXPECTED" || state === "QUEUED") return "pending";
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
 * Chunks run in parallel; fork fallback batches run in parallel.
 */
async function graphqlSearchPRs(
  octokit: GitHubOctokit,
  repos: RepoRef[],
  userLogin: string
): Promise<FetchPullRequestsResult> {
  if (!VALID_LOGIN.test(userLogin)) return { pullRequests: [], errors: [{ repo: "pr-search", statusCode: null, message: "Invalid userLogin", retryable: false }] };

  const chunks = chunkArray(repos, SEARCH_REPO_BATCH_SIZE);
  const prMap = new Map<number, PullRequest>();
  const forkInfoMap = new Map<number, { owner: string; repoName: string }>();
  const errors: ApiError[] = [];
  const CAP = 1000;

  function processPRNode(node: GraphQLPRNode): boolean {
    if (node.databaseId == null || !node.repository) return false;
    if (prMap.has(node.databaseId)) return false;

    const pendingLogins = node.reviewRequests.nodes
      .map((n) => n.requestedReviewer?.login)
      .filter((l): l is string => l != null);
    const actualLogins = node.latestReviews.nodes
      .map((n) => n.author?.login)
      .filter((l): l is string => l != null);
    const reviewerLogins = [...new Set([...pendingLogins, ...actualLogins].map(l => l.toLowerCase()))];

    let checkStatus = mapCheckStatus(node.commits.nodes[0]?.commit?.statusCheckRollup?.state ?? null);
    // mergeStateStatus overrides checkStatus when it indicates action is needed.
    // BLOCKED means required checks/reviews haven't passed — leave checkStatus from rollup.
    const mss = node.mergeStateStatus;
    if (mss === "DIRTY" || mss === "BEHIND") {
      checkStatus = "conflict";
    } else if (mss === "UNSTABLE") {
      checkStatus = "failure";
    } else if (mss === "UNKNOWN" && checkStatus === null) {
      checkStatus = null; // no-op, kept explicit for clarity
    }

    // Store fork info for fallback detection
    if (node.headRepository) {
      const parts = node.headRepository.nameWithOwner.split("/");
      if (parts.length === 2) {
        forkInfoMap.set(node.databaseId, { owner: node.headRepository.owner.login, repoName: parts[1] });
      }
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
    return true;
  }

  // Run involves and review-requested searches across all repo chunks in parallel
  const queryTypes = [
    `is:pr is:open involves:${userLogin}`,
    `is:pr is:open review-requested:${userLogin}`,
  ];

  const allTasks = queryTypes.flatMap((queryType) =>
    chunks.map(async (chunk, chunkIdx) => {
      const repoQualifiers = buildRepoQualifiers(chunk);
      const queryString = `${queryType} ${repoQualifiers}`;
      await paginateGraphQLSearch<GraphQLPRSearchResponse, GraphQLPRNode>(
        octokit, PR_SEARCH_QUERY, queryString,
        `pr-search-batch-${chunkIdx + 1}/${chunks.length}`,
        errors, processPRNode, () => prMap.size, CAP,
      );
    })
  );

  const taskResults = await Promise.allSettled(allTasks);
  for (const result of taskResults) {
    if (result.status === "rejected") {
      const { statusCode, message } = extractRejectionError(result.reason);
      errors.push({ repo: "pr-search-batch", statusCode, message, retryable: statusCode === null || statusCode >= 500 });
    }
  }

  if (prMap.size >= CAP) {
    console.warn(`[api] PR search results capped at ${CAP}`);
    pushNotification("search/prs", `PR search results capped at 1,000 — some items are hidden`, "warning");
  }

  // Fork PR fallback: for PRs with null checkStatus where head repo owner differs from base
  const forkCandidates: ForkCandidate[] = [];
  for (const [databaseId, pr] of prMap) {
    if (pr.checkStatus !== null) continue;
    const headInfo = forkInfoMap.get(databaseId);
    if (!headInfo) continue;
    const baseOwner = pr.repoFullName.split("/")[0].toLowerCase();
    if (headInfo.owner.toLowerCase() === baseOwner) continue;
    forkCandidates.push({ databaseId, headOwner: headInfo.owner, headRepo: headInfo.repoName, sha: pr.headSha });
  }

  if (forkCandidates.length > 0) {
    const forkChunks = chunkArray(forkCandidates, GRAPHQL_CHECK_BATCH_SIZE);
    // Run fork fallback batches in parallel
    await Promise.allSettled(forkChunks.map(async (forkChunk) => {
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
          const pr = prMap.get(forkChunk[i].databaseId);
          if (pr) pr.checkStatus = mapCheckStatus(state);
        }
      } catch (err) {
        // Extract partial data from GraphqlResponseError — some fork aliases may have resolved
        const partialData = (err && typeof err === "object" && "data" in err && err.data && typeof err.data === "object")
          ? err.data as Record<string, ForkRepoResult | null | undefined>
          : null;

        if (partialData) {
          for (let i = 0; i < forkChunk.length; i++) {
            const data = partialData[`fork${i}`];
            if (!data) continue;
            const state = data.object?.statusCheckRollup?.state ?? null;
            const pr = prMap.get(forkChunk[i].databaseId);
            if (pr) pr.checkStatus = mapCheckStatus(state);
          }
        }

        console.warn("[api] Fork PR statusCheckRollup fallback partially failed:", err);
        pushNotification("graphql", "Fork PR check status unavailable — CI status may be missing for some PRs", "warning");
      }
    }));
  }

  const pullRequests = [...prMap.values()];
  if (pullRequests.length >= CAP) pullRequests.splice(CAP);
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

  const RUNS_CONCURRENCY = 20;
  const tasks = repos.map((repo) => async () => {
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
  });

  const taskResults = await pooledAllSettled(tasks, RUNS_CONCURRENCY);
  for (const result of taskResults) {
    if (result.status === "rejected") {
      const { statusCode, message } = extractRejectionError(result.reason);
      allErrors.push({ repo: "workflow-runs", statusCode, message, retryable: true });
    }
  }

  return { workflowRuns: allRuns, errors: allErrors };
}

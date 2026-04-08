import { getClient, cachedRequest, updateGraphqlRateLimit } from "./github";
import { pushNotification } from "../lib/errors";
import type { ApiCallSource } from "./api-usage";
import type { TrackedUser } from "../stores/config";

// ── Types ────────────────────────────────────────────────────────────────────

interface GraphQLRateLimit {
  limit: number;
  remaining: number;
  resetAt: string;
}

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

const VALID_REPO_NAME = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
// Allows alphanumeric/hyphen base (1-39 chars) with optional literal [bot] suffix for GitHub
// App bot accounts. Case-sensitive [bot] is intentional — GitHub always uses lowercase.
const VALID_TRACKED_LOGIN = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;

const SEARCH_RESULT_CAP = 1000;

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
export async function pooledAllSettled<T>(
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
  repository: { nameWithOwner: string; stargazerCount: number } | null;
  comments: { totalCount: number };
}

interface GraphQLIssueSearchResponse {
  search: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (GraphQLIssueNode | null)[];
  };
  rateLimit?: GraphQLRateLimit;
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
  rateLimit?: GraphQLRateLimit;
  [key: string]: ForkRepoResult | GraphQLRateLimit | undefined | null;
}

// ── GraphQL search query constants ───────────────────────────────────────────

const LIGHT_ISSUE_FRAGMENT = `
  fragment LightIssueFields on Issue {
    databaseId
    number
    title
    state
    url
    createdAt
    updatedAt
    author { login avatarUrl }
    labels(first: 10) { nodes { name color } }
    assignees(first: 10) { nodes { login } }
    repository { nameWithOwner stargazerCount }
    comments { totalCount }
  }
`;

const ISSUES_SEARCH_QUERY = `
  query($q: String!, $cursor: String) {
    search(query: $q, type: ISSUE, first: 50, after: $cursor) {
      issueCount
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on Issue {
          ...LightIssueFields
        }
      }
    }
    rateLimit { limit remaining resetAt }
  }
  ${LIGHT_ISSUE_FRAGMENT}
`;

// ── Two-phase rendering: light + heavy queries ───────────────────────────────

const LIGHT_PR_FRAGMENT = `
  fragment LightPRFields on PullRequest {
    id
    databaseId
    number
    title
    state
    isDraft
    url
    createdAt
    updatedAt
    author { login avatarUrl }
    repository { nameWithOwner stargazerCount }
    headRefName
    baseRefName
    reviewDecision
    labels(first: 10) { nodes { name color } }
  }
`;

/**
 * Phase 1 query: fetches issues fully and PRs with minimal fields.
 * PR enrichment (check status, size, reviewers, etc.) comes from phase 2.
 */
const LIGHT_COMBINED_SEARCH_QUERY = `
  query($issueQ: String!, $prInvQ: String!, $prRevQ: String!,
        $issueCursor: String, $prInvCursor: String, $prRevCursor: String) {
    issues: search(query: $issueQ, type: ISSUE, first: 50, after: $issueCursor) {
      issueCount
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on Issue {
          ...LightIssueFields
        }
      }
    }
    prInvolves: search(query: $prInvQ, type: ISSUE, first: 50, after: $prInvCursor) {
      issueCount
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on PullRequest {
          ...LightPRFields
        }
      }
    }
    prReviewReq: search(query: $prRevQ, type: ISSUE, first: 50, after: $prRevCursor) {
      issueCount
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on PullRequest {
          ...LightPRFields
        }
      }
    }
    rateLimit { limit remaining resetAt }
  }
  ${LIGHT_ISSUE_FRAGMENT}
  ${LIGHT_PR_FRAGMENT}
`;

/**
 * Unfiltered search query for monitored repos — fetches all open issues and PRs
 * without any involves: qualifier. Used when a repo is marked for monitor-all mode.
 * Variables: $issueQ, $prQ, $issueCursor, $prCursor.
 */
const UNFILTERED_SEARCH_QUERY = `
  query($issueQ: String!, $prQ: String!, $issueCursor: String, $prCursor: String) {
    issues: search(query: $issueQ, type: ISSUE, first: 50, after: $issueCursor) {
      issueCount
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on Issue {
          ...LightIssueFields
        }
      }
    }
    prs: search(query: $prQ, type: ISSUE, first: 50, after: $prCursor) {
      issueCount
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on PullRequest {
          ...LightPRFields
        }
      }
    }
    rateLimit { limit remaining resetAt }
  }
  ${LIGHT_ISSUE_FRAGMENT}
  ${LIGHT_PR_FRAGMENT}
`;

interface UnfilteredSearchResponse {
  issues: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (GraphQLIssueNode | null)[];
  };
  prs: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (GraphQLLightPRNode | null)[];
  };
  rateLimit?: GraphQLRateLimit;
}

/** Standalone light PR search query for pagination follow-ups. */
const LIGHT_PR_SEARCH_QUERY = `
  query($q: String!, $cursor: String) {
    search(query: $q, type: ISSUE, first: 50, after: $cursor) {
      issueCount
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on PullRequest {
          ...LightPRFields
        }
      }
    }
    rateLimit { limit remaining resetAt }
  }
  ${LIGHT_PR_FRAGMENT}
`;

interface LightPRSearchResponse {
  search: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (GraphQLLightPRNode | null)[];
  };
  rateLimit?: GraphQLRateLimit;
}

/** Phase 2 backfill query: enriches PRs with heavy fields using node IDs. */
const HEAVY_PR_BACKFILL_QUERY = `
  query($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on PullRequest {
        databaseId
        headRefOid
        headRepository { owner { login } nameWithOwner }
        mergeStateStatus
        assignees(first: 10) { nodes { login } }
        reviewRequests(first: 10) {
          nodes { requestedReviewer { ... on User { login } } }
        }
        latestReviews(first: 5) {
          totalCount
          nodes { author { login } }
        }
        additions
        deletions
        changedFiles
        comments { totalCount }
        reviewThreads { totalCount }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup { state }
            }
          }
        }
      }
    }
    rateLimit { limit remaining resetAt }
  }
`;

/** Hot-poll query: fetches current status fields for a batch of PR node IDs. */
const HOT_PR_STATUS_QUERY = `
  query($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on PullRequest {
        databaseId
        state
        mergeStateStatus
        reviewDecision
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup { state }
            }
          }
        }
      }
    }
    rateLimit { limit remaining resetAt }
  }
`;

interface HotPRStatusNode {
  databaseId: number;
  state: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

interface HotPRStatusResponse {
  nodes: (HotPRStatusNode | null)[];
  rateLimit?: GraphQLRateLimit;
}

interface GraphQLLightPRNode {
  id: string; // GraphQL global node ID
  databaseId: number;
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  url: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string; avatarUrl: string } | null;
  repository: { nameWithOwner: string; stargazerCount: number } | null;
  headRefName: string;
  baseRefName: string;
  reviewDecision: string | null;
  labels: { nodes: { name: string; color: string }[] };
}

interface GraphQLHeavyPRNode {
  databaseId: number;
  headRefOid: string;
  headRepository: { owner: { login: string }; nameWithOwner: string } | null;
  mergeStateStatus: string;
  assignees: { nodes: { login: string }[] };
  reviewRequests: { nodes: { requestedReviewer: { login: string } | null }[] };
  latestReviews: {
    totalCount: number;
    nodes: { author: { login: string } | null }[];
  };
  additions: number;
  deletions: number;
  changedFiles: number;
  comments: { totalCount: number };
  reviewThreads: { totalCount: number };
  commits: {
    nodes: {
      commit: {
        statusCheckRollup: { state: string } | null;
      };
    }[];
  };
}

interface LightCombinedSearchResponse {
  issues: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (GraphQLIssueNode | null)[];
  };
  prInvolves: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (GraphQLLightPRNode | null)[];
  };
  prReviewReq: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (GraphQLLightPRNode | null)[];
  };
  rateLimit?: GraphQLRateLimit;
}

interface HeavyBackfillResponse {
  nodes: (GraphQLHeavyPRNode | null)[];
  rateLimit?: GraphQLRateLimit;
}

// Max node IDs per nodes() query (GitHub limit)
const NODES_BATCH_SIZE = 100;

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
async function paginateGraphQLSearch<TResponse extends { search: SearchPageResult<TNode>; rateLimit?: GraphQLRateLimit }, TNode>(
  octokit: GitHubOctokit,
  query: string,
  queryString: string,
  batchLabel: string,
  errors: ApiError[],
  processNode: (node: TNode) => boolean, // returns true if node was added (for cap counting)
  currentCount: () => number,
  cap: number,
  source: ApiCallSource,
  startCursor?: string | null,
): Promise<{ capReached: boolean }> {
  let cursor: string | null = startCursor ?? null;
  let capReached = false;

  while (true) {
    try {
      let response: TResponse;
      let isPartial = false;
      try {
        response = await octokit.graphql<TResponse>(query, { q: queryString, cursor, request: { apiSource: source } });
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

      if (response.rateLimit) {
        updateGraphqlRateLimit(response.rateLimit);
      }

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
    starCount: node.repository.stargazerCount,
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

    const forkQuery = `query(${varDefs.join(", ")}) {\n${fragments.join("\n")}\nrateLimit { limit remaining resetAt }\n}`;

    try {
      const forkResponse = await octokit.graphql<ForkQueryResponse>(forkQuery, { ...variables, request: { apiSource: "forkCheck" } });
      if (forkResponse.rateLimit) {
        updateGraphqlRateLimit(forkResponse.rateLimit as GraphQLRateLimit);
      }

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

// ── Two-phase: light combined search ──────────────────────────────────────────

interface LightSearchResult {
  issues: Issue[];
  pullRequests: PullRequest[];
  errors: ApiError[];
}

/**
 * Processes a light PR node into a PullRequest with default values for heavy fields.
 * Returns true if the node was added (not a duplicate or invalid).
 * Stores the GraphQL node ID in nodeIdMap for later backfill.
 */
function processLightPRNode(
  node: GraphQLLightPRNode,
  prMap: Map<number, PullRequest>,
  nodeIdMap: Map<number, string>
): boolean {
  if (node.databaseId == null || !node.repository) return false;
  if (prMap.has(node.databaseId)) return false;

  nodeIdMap.set(node.databaseId, node.id);
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
    headSha: "",
    headRef: node.headRefName,
    baseRef: node.baseRefName,
    assigneeLogins: [],
    reviewerLogins: [],
    repoFullName: node.repository.nameWithOwner,
    checkStatus: null,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    comments: 0,
    reviewThreads: 0,
    labels: node.labels.nodes.map((l) => ({ name: l.name, color: l.color })),
    reviewDecision: mapReviewDecision(node.reviewDecision),
    totalReviewCount: 0,
    starCount: node.repository.stargazerCount,
    enriched: false,
    nodeId: node.id,
  });
  return true;
}

/**
 * Executes a single LIGHT_COMBINED_SEARCH_QUERY with partial-error handling,
 * node processing, and pagination follow-ups. Shared by both the chunked
 * repo-scoped search and the unscoped global user search.
 */
async function executeLightCombinedQuery(
  octokit: GitHubOctokit,
  issueQ: string,
  prInvQ: string,
  prRevQ: string,
  errorLabel: string,
  issueSeen: Set<number>,
  issues: Issue[],
  prMap: Map<number, PullRequest>,
  nodeIdMap: Map<number, string>,
  errors: ApiError[],
  issueCap: number,
  prCap: number,
  source: ApiCallSource,
): Promise<void> {
  let response: LightCombinedSearchResponse;
  let isPartial = false;
  try {
    response = await octokit.graphql<LightCombinedSearchResponse>(LIGHT_COMBINED_SEARCH_QUERY, {
      issueQ, prInvQ, prRevQ,
      issueCursor: null, prInvCursor: null, prRevCursor: null,
      request: { apiSource: source },
    });
  } catch (err) {
    const partial = (err && typeof err === "object" && "data" in err && err.data && typeof err.data === "object")
      ? err.data as Partial<LightCombinedSearchResponse>
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
      errors.push({ repo: errorLabel, statusCode: null, message, retryable: true });
    } else {
      throw err;
    }
  }

  if (response.rateLimit) {
    updateGraphqlRateLimit(response.rateLimit);
  }

  for (const node of response.issues.nodes) {
    if (issues.length >= issueCap) break;
    if (!node) continue;
    processIssueNode(node, issueSeen, issues);
  }
  for (const node of response.prInvolves.nodes) {
    if (prMap.size >= prCap) break;
    if (!node) continue;
    processLightPRNode(node, prMap, nodeIdMap);
  }
  for (const node of response.prReviewReq.nodes) {
    if (prMap.size >= prCap) break;
    if (!node) continue;
    processLightPRNode(node, prMap, nodeIdMap);
  }

  if (isPartial) return;

  if (response.issues.pageInfo.hasNextPage && response.issues.pageInfo.endCursor && issues.length < issueCap) {
    await paginateGraphQLSearch<GraphQLIssueSearchResponse, GraphQLIssueNode>(
      octokit, ISSUES_SEARCH_QUERY, issueQ, errorLabel, errors,
      (node) => processIssueNode(node, issueSeen, issues),
      () => issues.length, issueCap, source, response.issues.pageInfo.endCursor,
    );
  }

  const prPaginationTasks: Promise<unknown>[] = [];
  if (response.prInvolves.pageInfo.hasNextPage && response.prInvolves.pageInfo.endCursor && prMap.size < prCap) {
    prPaginationTasks.push(paginateGraphQLSearch<LightPRSearchResponse, GraphQLLightPRNode>(
      octokit, LIGHT_PR_SEARCH_QUERY, prInvQ, errorLabel, errors,
      (node) => processLightPRNode(node, prMap, nodeIdMap),
      () => prMap.size, prCap, source, response.prInvolves.pageInfo.endCursor,
    ));
  }
  if (response.prReviewReq.pageInfo.hasNextPage && response.prReviewReq.pageInfo.endCursor && prMap.size < prCap) {
    prPaginationTasks.push(paginateGraphQLSearch<LightPRSearchResponse, GraphQLLightPRNode>(
      octokit, LIGHT_PR_SEARCH_QUERY, prRevQ, errorLabel, errors,
      (node) => processLightPRNode(node, prMap, nodeIdMap),
      () => prMap.size, prCap, source, response.prReviewReq.pageInfo.endCursor,
    ));
  }
  if (prPaginationTasks.length > 0) {
    await Promise.allSettled(prPaginationTasks);
  }
}

/** Cap-check, notify, and assemble a LightSearchResult from working collections. */
function finalizeSearchResult(
  issues: Issue[],
  prMap: Map<number, PullRequest>,
  errors: ApiError[],
  issueSource: string,
  prSource: string,
  issueLabel: string,
  prLabel: string,
): LightSearchResult {
  if (issues.length >= SEARCH_RESULT_CAP) {
    console.warn(`[api] ${issueLabel} capped at ${SEARCH_RESULT_CAP}`);
    pushNotification(issueSource, `${issueLabel} capped at ${SEARCH_RESULT_CAP.toLocaleString("en-US")} — some items are hidden`, "warning");
    issues.splice(SEARCH_RESULT_CAP);
  }

  if (prMap.size >= SEARCH_RESULT_CAP) {
    console.warn(`[api] ${prLabel} capped at ${SEARCH_RESULT_CAP}`);
    pushNotification(prSource, `${prLabel} capped at ${SEARCH_RESULT_CAP.toLocaleString("en-US")} — some items are hidden`, "warning");
  }

  const pullRequests = [...prMap.values()];
  if (pullRequests.length >= SEARCH_RESULT_CAP) pullRequests.splice(SEARCH_RESULT_CAP);
  return { issues, pullRequests, errors };
}

/**
 * Phase 1: light combined search. Fetches issues fully and PRs with minimal fields.
 * Returns light PRs (enriched: false) and their GraphQL node IDs for phase 2 backfill.
 */
async function graphqlLightCombinedSearch(
  octokit: GitHubOctokit,
  repos: RepoRef[],
  userLogin: string,
  source: ApiCallSource,
): Promise<LightSearchResult> {
  if (!VALID_TRACKED_LOGIN.test(userLogin)) {
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
  const nodeIdMap = new Map<number, string>();
  const errors: ApiError[] = [];

  await Promise.allSettled(chunks.map(async (chunk, chunkIdx) => {
    const repoQualifiers = buildRepoQualifiers(chunk);
    const issueQ = `is:issue is:open involves:${userLogin} ${repoQualifiers}`;
    const prInvQ = `is:pr is:open involves:${userLogin} ${repoQualifiers}`;
    const prRevQ = `is:pr is:open review-requested:${userLogin} ${repoQualifiers}`;
    const batchLabel = `light-batch-${chunkIdx + 1}/${chunks.length}`;

    try {
      await executeLightCombinedQuery(
        octokit, issueQ, prInvQ, prRevQ, batchLabel,
        issueSeen, issues, prMap, nodeIdMap, errors, SEARCH_RESULT_CAP, SEARCH_RESULT_CAP, source,
      );
    } catch (err) {
      const { statusCode, message } = extractRejectionError(err);
      errors.push({ repo: batchLabel, statusCode, message, retryable: statusCode === null || statusCode >= 500 });
    }
  }));

  return finalizeSearchResult(
    issues, prMap, errors,
    "search/issues", "search/prs",
    "Issue search results", "PR search results",
  );
}

/**
 * Unfiltered search for monitored repos — returns all open issues + PRs without
 * any user qualifier (no involves:, no review-requested:). Intentionally accepts
 * no user login parameter; input is limited to repo names validated through
 * buildRepoQualifiers (which applies VALID_REPO_NAME).
 */
async function graphqlUnfilteredSearch(
  octokit: GitHubOctokit,
  repos: RepoRef[]
): Promise<LightSearchResult> {
  if (repos.length === 0) return { issues: [], pullRequests: [], errors: [] };

  const chunks = chunkArray(repos, SEARCH_REPO_BATCH_SIZE);
  const issueSeen = new Set<number>();
  const issues: Issue[] = [];
  const prMap = new Map<number, PullRequest>();
  const nodeIdMap = new Map<number, string>();
  const errors: ApiError[] = [];

  await Promise.allSettled(chunks.map(async (chunk, chunkIdx) => {
    const repoQualifiers = buildRepoQualifiers(chunk);
    const issueQ = `is:issue is:open ${repoQualifiers}`;
    const prQ = `is:pr is:open ${repoQualifiers}`;
    const batchLabel = `unfiltered-batch-${chunkIdx + 1}/${chunks.length}`;

    try {
      let response: UnfilteredSearchResponse;
      let isPartial = false;
      try {
        response = await octokit.graphql<UnfilteredSearchResponse>(UNFILTERED_SEARCH_QUERY, {
          issueQ, prQ, issueCursor: null, prCursor: null,
          request: { apiSource: "unfilteredSearch" },
        });
      } catch (err) {
        const partial = (err && typeof err === "object" && "data" in err && err.data && typeof err.data === "object")
          ? err.data as Partial<UnfilteredSearchResponse>
          : null;
        if (partial && (partial.issues || partial.prs)) {
          response = {
            issues: partial.issues ?? { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            prs: partial.prs ?? { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            rateLimit: partial.rateLimit,
          };
          isPartial = true;
          const { message } = extractRejectionError(err);
          errors.push({ repo: batchLabel, statusCode: null, message, retryable: true });
        } else {
          const { statusCode, message } = extractRejectionError(err);
          errors.push({ repo: batchLabel, statusCode, message, retryable: statusCode === null || statusCode >= 500 });
          return;
        }
      }

      if (response.rateLimit) {
        updateGraphqlRateLimit(response.rateLimit);
      }

      for (const node of response.issues.nodes) {
        if (issues.length >= SEARCH_RESULT_CAP) break;
        if (!node) continue;
        processIssueNode(node, issueSeen, issues);
      }
      for (const node of response.prs.nodes) {
        if (prMap.size >= SEARCH_RESULT_CAP) break;
        if (!node) continue;
        processLightPRNode(node, prMap, nodeIdMap);
      }

      if (isPartial) return;

      if (response.issues.pageInfo.hasNextPage && response.issues.pageInfo.endCursor && issues.length < SEARCH_RESULT_CAP) {
        await paginateGraphQLSearch<GraphQLIssueSearchResponse, GraphQLIssueNode>(
          octokit, ISSUES_SEARCH_QUERY, issueQ, batchLabel, errors,
          (node) => processIssueNode(node, issueSeen, issues),
          () => issues.length, SEARCH_RESULT_CAP, "unfilteredSearch", response.issues.pageInfo.endCursor,
        );
      }

      if (response.prs.pageInfo.hasNextPage && response.prs.pageInfo.endCursor && prMap.size < SEARCH_RESULT_CAP) {
        await paginateGraphQLSearch<LightPRSearchResponse, GraphQLLightPRNode>(
          octokit, LIGHT_PR_SEARCH_QUERY, prQ, batchLabel, errors,
          (node) => processLightPRNode(node, prMap, nodeIdMap),
          () => prMap.size, SEARCH_RESULT_CAP, "unfilteredSearch", response.prs.pageInfo.endCursor,
        );
      }
    } catch (err) {
      const { statusCode, message } = extractRejectionError(err);
      errors.push({ repo: batchLabel, statusCode, message, retryable: statusCode === null || statusCode >= 500 });
    }
  }));

  return finalizeSearchResult(
    issues, prMap, errors,
    "search/unfiltered-issues", "search/unfiltered-prs",
    "Monitored repo issue results", "Monitored repo PR results",
  );
}

// ── Two-phase: heavy backfill ─────────────────────────────────────────────────

export interface PREnrichmentData {
  id: number;
  headSha: string;
  headRepository: { owner: string; repoName: string } | null;
  assigneeLogins: string[];
  reviewerLogins: string[];
  checkStatus: CheckStatus["status"];
  additions: number;
  deletions: number;
  changedFiles: number;
  comments: number;
  reviewThreads: number;
  totalReviewCount: number;
}

/**
 * Phase 2: fetches heavy PR fields using `nodes(ids: [...])` query.
 * Returns enrichment data keyed by databaseId.
 */
export async function fetchPREnrichment(
  octokit: GitHubOctokit,
  nodeIds: string[]
): Promise<{ enrichments: Map<number, PREnrichmentData>; errors: ApiError[] }> {
  const enrichments = new Map<number, PREnrichmentData>();
  const errors: ApiError[] = [];

  if (nodeIds.length === 0) return { enrichments, errors };

  const batches = chunkArray(nodeIds, NODES_BATCH_SIZE);
  await Promise.allSettled(batches.map(async (batch, batchIdx) => {
    try {
      const response = await octokit.graphql<HeavyBackfillResponse>(HEAVY_PR_BACKFILL_QUERY, {
        ids: batch,
        request: { apiSource: "heavyBackfill" },
      });

      if (response.rateLimit) {
        updateGraphqlRateLimit(response.rateLimit);
      }

      for (const node of response.nodes) {
        if (!node || node.databaseId == null) continue;

        const pendingLogins = node.reviewRequests.nodes
          .map((n) => n.requestedReviewer?.login)
          .filter((l): l is string => l != null);
        const actualLogins = node.latestReviews.nodes
          .map((n) => n.author?.login)
          .filter((l): l is string => l != null);
        const reviewerLogins = [...new Set([...pendingLogins, ...actualLogins].map(l => l.toLowerCase()))];

        const checkStatus = applyMergeStateOverride(
          node.mergeStateStatus,
          mapCheckStatus(node.commits.nodes[0]?.commit?.statusCheckRollup?.state ?? null),
        );

        let headRepository: PREnrichmentData["headRepository"] = null;
        if (node.headRepository) {
          const parts = node.headRepository.nameWithOwner.split("/");
          if (parts.length === 2) {
            headRepository = { owner: node.headRepository.owner.login, repoName: parts[1] };
          }
        }

        enrichments.set(node.databaseId, {
          id: node.databaseId,
          headSha: node.headRefOid,
          headRepository,
          assigneeLogins: node.assignees.nodes.map((a) => a.login),
          reviewerLogins,
          checkStatus,
          additions: node.additions,
          deletions: node.deletions,
          changedFiles: node.changedFiles,
          comments: node.comments.totalCount,
          reviewThreads: node.reviewThreads.totalCount,
          totalReviewCount: node.latestReviews.totalCount,
        });
      }
    } catch (err) {
      const { statusCode, message } = extractRejectionError(err);
      errors.push({
        repo: `backfill-batch-${batchIdx + 1}/${batches.length}`,
        statusCode, message,
        retryable: statusCode === null || statusCode >= 500,
      });
    }
  }));

  return { enrichments, errors };
}

/**
 * Merges phase 2 enrichment data into light PRs. Returns enriched PR array.
 * Also detects fork PRs for the statusCheckRollup fallback.
 */
function mergeEnrichment(
  lightPRs: PullRequest[],
  enrichments: Map<number, PREnrichmentData>,
  forkInfoMap: Map<number, { owner: string; repoName: string }>
): PullRequest[] {
  return lightPRs.map((pr) => {
    const e = enrichments.get(pr.id);
    if (!e) return pr; // Keep enriched: false if backfill missed this PR

    if (e.headRepository) {
      forkInfoMap.set(pr.id, e.headRepository);
    }

    return {
      ...pr,
      headSha: e.headSha,
      assigneeLogins: e.assigneeLogins,
      reviewerLogins: e.reviewerLogins,
      checkStatus: e.checkStatus,
      additions: e.additions,
      deletions: e.deletions,
      changedFiles: e.changedFiles,
      comments: e.comments,
      reviewThreads: e.reviewThreads,
      totalReviewCount: e.totalReviewCount,
      enriched: true,
    };
  });
}

/**
 * Merges tracked user search results into the main issue/PR maps.
 * Items already present get the tracked user's login appended to surfacedBy.
 * New items are added with surfacedBy: [trackedLogin].
 */
function mergeTrackedUserResults(
  issueMap: Map<number, Issue>,
  prMap: Map<number, PullRequest>,
  nodeIdMap: Map<number, string>,
  trackedResult: LightSearchResult,
  trackedLogin: string
): void {
  const login = trackedLogin.toLowerCase();

  for (const issue of trackedResult.issues) {
    const existing = issueMap.get(issue.id);
    if (existing) {
      if (!existing.surfacedBy?.includes(login)) {
        existing.surfacedBy = [...(existing.surfacedBy ?? []), login];
      }
    } else {
      issueMap.set(issue.id, { ...issue, surfacedBy: [login] });
    }
  }

  for (const pr of trackedResult.pullRequests) {
    const existing = prMap.get(pr.id);
    if (existing) {
      if (!existing.surfacedBy?.includes(login)) {
        existing.surfacedBy = [...(existing.surfacedBy ?? []), login];
      }
    } else {
      prMap.set(pr.id, { ...pr, surfacedBy: [login] });
      // Register node ID for backfill if this PR is new
      if (pr.nodeId) nodeIdMap.set(pr.id, pr.nodeId);
    }
  }
}

/**
 * Fetches open issues and PRs using a two-phase approach:
 * - Phase 1 (light): minimal fields for immediate rendering
 * - Phase 2 (heavy): enrichment via nodes(ids:[]) backfill
 *
 * If onLightData is provided, it fires after phase 1 with light data
 * (including surfacedBy annotations) so the UI can render immediately.
 * The returned promise resolves with fully enriched data after phase 2.
 *
 * If trackedUsers is provided, their global searches run in parallel after
 * phase 1 completes. Results are merged by databaseId with surfacedBy tracking.
 */
export async function fetchIssuesAndPullRequests(
  octokit: ReturnType<typeof getClient>,
  repos: RepoRef[],
  userLogin: string,
  onLightData?: (data: FetchIssuesAndPRsResult) => void,
  trackedUsers?: TrackedUser[],
  monitoredRepos?: RepoRef[],
): Promise<FetchIssuesAndPRsResult> {
  if (!octokit) throw new Error("No GitHub client available");

  const hasTrackedUsers = (trackedUsers?.length ?? 0) > 0;

  // Partition repos into normal (involves: search) and monitored (unfiltered search)
  const monitoredSet = new Set((monitoredRepos ?? []).map((r) => r.fullName));
  const normalRepos = repos.filter((r) => !monitoredSet.has(r.fullName));
  const monitoredReposList = repos.filter((r) => monitoredSet.has(r.fullName));

  // Early exit — if no repos at all, return empty
  if (repos.length === 0) {
    return { issues: [], pullRequests: [], errors: [] };
  }

  const normalizedLogin = userLogin.toLowerCase();
  const allErrors: ApiError[] = [];

  // Working maps for merging results
  const issueMap = new Map<number, Issue>();
  const prMap = new Map<number, PullRequest>();
  const nodeIdMap = new Map<number, string>();

  // Phase 1: main user light search over normal repos (those not in monitoredRepos)
  if (normalRepos.length > 0 && userLogin) {
    const lightResult = await graphqlLightCombinedSearch(octokit, normalRepos, userLogin, "lightSearch");
    allErrors.push(...lightResult.errors);

    // Annotate main user's items with surfacedBy BEFORE firing onLightData
    for (const issue of lightResult.issues) {
      issueMap.set(issue.id, { ...issue, surfacedBy: [normalizedLogin] });
    }
    for (const pr of lightResult.pullRequests) {
      prMap.set(pr.id, { ...pr, surfacedBy: [normalizedLogin] });
      if (pr.nodeId) nodeIdMap.set(pr.id, pr.nodeId);
    }
  }

  // Fire onLightData with annotated main user data (tracked user results come later)
  if (onLightData && (issueMap.size > 0 || prMap.size > 0)) {
    onLightData({
      issues: [...issueMap.values()],
      pullRequests: [...prMap.values()],
      errors: allErrors,
    });
  }

  // Main user node IDs known — start backfill in parallel with tracked user searches.
  // This delivers enriched main-user PRs without waiting for tracked user pagination.
  const mainNodeIds = [...nodeIdMap.values()];
  const mainBackfillPromise = mainNodeIds.length > 0
    ? fetchPREnrichment(octokit, mainNodeIds)
    : Promise.resolve({ enrichments: new Map<number, PREnrichmentData>(), errors: [] as ApiError[] });

  // Tracked user searches — scoped to normalRepos only. Monitored repos are already
  // covered by graphqlUnfilteredSearch (all open items, no user qualifier), so running
  // involves: on them would duplicate work and add spurious surfacedBy annotations.
  const trackedSearchPromise = hasTrackedUsers && normalRepos.length > 0
    ? Promise.allSettled(trackedUsers!.map((u) => graphqlLightCombinedSearch(octokit, normalRepos, u.login, "globalUserSearch")))
    : Promise.resolve([] as PromiseSettledResult<LightSearchResult>[]);

  // Unfiltered search for monitored repos — runs in parallel with tracked searches
  const unfilteredPromise = monitoredReposList.length > 0
    ? graphqlUnfilteredSearch(octokit, monitoredReposList)
    : Promise.resolve({ issues: [], pullRequests: [], errors: [] } as LightSearchResult);

  const [mainBackfill, trackedResults, unfilteredResult] = await Promise.all([
    mainBackfillPromise,
    trackedSearchPromise,
    unfilteredPromise,
  ]);

  // Merge main backfill results
  const backfillErrors = [...mainBackfill.errors];
  const forkInfoMap = new Map<number, { owner: string; repoName: string }>();

  // Capture which PR IDs already exist BEFORE adding any new results (monitored or tracked users).
  // Delta backfill uses this set to identify PRs that need enrichment.
  const preNewPrIds = new Set(prMap.keys());

  // Merge unfiltered (monitored repo) results BEFORE tracked user merge.
  // Only insert items not already present from the involves: search (preserves surfacedBy).
  allErrors.push(...unfilteredResult.errors);
  for (const issue of unfilteredResult.issues) {
    if (!issueMap.has(issue.id)) {
      issueMap.set(issue.id, issue); // no surfacedBy — monitored repo item
    }
  }
  for (const pr of unfilteredResult.pullRequests) {
    if (!prMap.has(pr.id)) {
      prMap.set(pr.id, pr); // no surfacedBy — monitored repo item
      if (pr.nodeId) nodeIdMap.set(pr.id, pr.nodeId);
    }
  }

  // Merge tracked user results and collect new (delta) node IDs for both
  // monitored repo PRs (added above) and tracked user PRs (added below).
  if (hasTrackedUsers) {
    const settled = trackedResults as PromiseSettledResult<LightSearchResult>[];
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      const trackedLogin = trackedUsers![i].login;
      if (result.status === "fulfilled") {
        allErrors.push(...result.value.errors);
        mergeTrackedUserResults(issueMap, prMap, nodeIdMap, result.value, trackedLogin);
      } else {
        const { statusCode, message } = extractRejectionError(result.reason);
        allErrors.push({ repo: `tracked-user:${trackedLogin}`, statusCode, message, retryable: statusCode === null || statusCode >= 500 });
      }
    }
  }

  const mergedIssues = [...issueMap.values()];
  const mergedPRs = [...prMap.values()];

  // Apply main backfill enrichments to all PRs (main user PRs get enriched, tracked-only PRs get nothing yet)
  let enrichedPRs = mainBackfill.enrichments.size > 0
    ? mergeEnrichment(mergedPRs, mainBackfill.enrichments, forkInfoMap)
    : mergedPRs;

  // Delta backfill: enrich PRs not already covered by main backfill —
  // includes both monitored repo PRs and new PRs from tracked users
  const deltaNodeIds: string[] = [];
  for (const pr of mergedPRs) {
    if (!preNewPrIds.has(pr.id)) {
      const nodeId = nodeIdMap.get(pr.id);
      if (nodeId) deltaNodeIds.push(nodeId);
    }
  }

  if (deltaNodeIds.length > 0) {
    const delta = await fetchPREnrichment(octokit, deltaNodeIds);
    backfillErrors.push(...delta.errors);
    enrichedPRs = mergeEnrichment(enrichedPRs, delta.enrichments, forkInfoMap);
  }

  // Fork PR fallback for enriched PRs
  const enrichedPRMap = new Map(enrichedPRs.map(pr => [pr.id, pr]));
  await runForkPRFallback(octokit, enrichedPRMap, forkInfoMap);

  return {
    issues: mergedIssues,
    pullRequests: [...enrichedPRMap.values()],
    errors: [...allErrors, ...backfillErrors],
  };
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
 * Applies mergeStateStatus overrides to a PR's checkStatus.
 * DIRTY/BEHIND → conflict. UNSTABLE → failure unless checkStatus is already pending
 * (a pending rollup means checks are still running, not conclusively failed).
 * All other values (CLEAN, BLOCKED, HAS_HOOKS, UNKNOWN) pass through unchanged.
 */
function applyMergeStateOverride(
  mergeStateStatus: string | null | undefined,
  checkStatus: CheckStatus["status"],
): CheckStatus["status"] {
  if (mergeStateStatus === "DIRTY" || mergeStateStatus === "BEHIND") return "conflict";
  if (mergeStateStatus === "UNSTABLE" && checkStatus !== "pending") return "failure";
  return checkStatus;
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
  const REPO_CAP = 1000;

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
      if (repos.length >= REPO_CAP) break;
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
      if (repos.length >= REPO_CAP) break;
    }
  }

  if (repos.length >= REPO_CAP) {
    pushNotification(
      "api",
      `${orgOrUser} has 1000+ repos — showing the most recently active`,
      "warning",
    );
  }

  return repos;
}

// ── Step 3: fetchWorkflowRuns (single endpoint per repo) ─────────────────────

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

// ── Hot poll: targeted status updates ────────────────────────────────────────

export interface HotPRStatusUpdate {
  state: string;
  checkStatus: CheckStatus["status"];
  mergeStateStatus: string;
  reviewDecision: PullRequest["reviewDecision"];
}

/**
 * Fetches current status fields (check status, review decision, state) for a
 * batch of PR node IDs using the nodes() GraphQL query. Returns a map keyed
 * by databaseId. Uses Promise.allSettled per batch for error resilience.
 */
export async function fetchHotPRStatus(
  octokit: GitHubOctokit,
  nodeIds: string[]
): Promise<{ results: Map<number, HotPRStatusUpdate>; hadErrors: boolean }> {
  const results = new Map<number, HotPRStatusUpdate>();
  if (nodeIds.length === 0) return { results, hadErrors: false };

  const batches = chunkArray(nodeIds, NODES_BATCH_SIZE);
  let hadErrors = false;
  const settled = await Promise.allSettled(batches.map(async (batch) => {
    const response = await octokit.graphql<HotPRStatusResponse>(HOT_PR_STATUS_QUERY, { ids: batch, request: { apiSource: "hotPRStatus" } });
    if (response.rateLimit) {
      updateGraphqlRateLimit(response.rateLimit);
    }

    for (const node of response.nodes) {
      if (!node || node.databaseId == null) continue;

      const checkStatus = applyMergeStateOverride(
        node.mergeStateStatus,
        mapCheckStatus(node.commits.nodes[0]?.commit?.statusCheckRollup?.state ?? null),
      );

      results.set(node.databaseId, {
        state: node.state,
        checkStatus,
        mergeStateStatus: node.mergeStateStatus,
        reviewDecision: mapReviewDecision(node.reviewDecision),
      });
    }
  }));

  for (const s of settled) {
    if (s.status === "rejected") {
      hadErrors = true;
      console.warn("[hot-poll] PR status batch failed:", s.reason);
    }
  }

  return { results, hadErrors };
}

export interface HotWorkflowRunUpdate {
  id: number;
  status: string;
  conclusion: string | null;
  updatedAt: string;
  completedAt: string | null;
}

/**
 * Fetches current status for a single workflow run by ID.
 * Used by hot-poll to refresh in-progress runs without a full re-fetch.
 */
export async function fetchWorkflowRunById(
  octokit: GitHubOctokit,
  descriptor: { id: number; owner: string; repo: string }
): Promise<HotWorkflowRunUpdate> {
  const { id, owner, repo } = descriptor;
  const response = await octokit.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}", {
    owner,
    repo,
    run_id: id,
  });
  // Octokit's generated type for this endpoint omits completed_at; cast to our full raw shape
  const run = response.data as unknown as RawWorkflowRun;
  return {
    id: run.id,
    status: run.status ?? "",
    conclusion: run.conclusion ?? null,
    updatedAt: run.updated_at,
    completedAt: run.completed_at ?? null,
  };
}

// ── User validation + upstream repo discovery ─────────────────────────────────

const AVATAR_CDN_PREFIX = "https://avatars.githubusercontent.com/";
const AVATAR_FALLBACK = `${AVATAR_CDN_PREFIX}u/0`;

interface RawGitHubUser {
  login: string;
  avatar_url: string;
  name: string | null;
  type: string;
}

/**
 * Validates a GitHub user login and returns their profile data.
 * Uses a strict login regex to prevent injection into GraphQL query strings.
 * Returns null if the login is invalid or the user does not exist (404).
 * Throws on network or server errors.
 */
export async function validateGitHubUser(
  octokit: GitHubOctokit,
  login: string
): Promise<TrackedUser | null> {
  if (!VALID_TRACKED_LOGIN.test(login)) return null;

  let response: { data: RawGitHubUser; headers: Record<string, string> };
  try {
    response = await octokit.request("GET /users/{username}", { username: login }) as { data: RawGitHubUser; headers: Record<string, string> };
  } catch (err) {
    const status =
      typeof err === "object" && err !== null && "status" in err
        ? (err as { status: number }).status
        : null;
    if (status === 404) return null;
    throw err;
  }
  const raw = response.data;
  const avatarUrl = raw.avatar_url.startsWith(AVATAR_CDN_PREFIX)
    ? raw.avatar_url
    : AVATAR_FALLBACK;

  return {
    login: raw.login.toLowerCase(),
    avatarUrl,
    name: raw.name ?? null,
    type: raw.type === "Bot" ? "bot" : "user",
  };
}

/**
 * Discovers repos the user participates in but doesn't own, via unscoped
 * GraphQL search (no repo: qualifiers). Returns up to 100 repos sorted
 * alphabetically, excluding any in the provided excludeRepos set.
 * When trackedUsers is provided, also discovers repos those users participate in.
 */
export async function discoverUpstreamRepos(
  octokit: GitHubOctokit,
  userLogin: string,
  excludeRepos: Set<string>,
  trackedUsers?: TrackedUser[]
): Promise<RepoRef[]> {
  const repoNames = new Set<string>();
  const errors: ApiError[] = [];
  const CAP = 100;

  function extractRepoName(node: { repository?: { nameWithOwner: string } | null }): boolean {
    const name = node.repository?.nameWithOwner;
    if (!name) return false;
    if (excludeRepos.has(name)) return false;
    repoNames.add(name);
    return true;
  }

  function discoverForUser(login: string) {
    const issueQ = `is:issue is:open involves:${login}`;
    const prQ = `is:pr is:open involves:${login}`;
    return Promise.allSettled([
      paginateGraphQLSearch<GraphQLIssueSearchResponse, GraphQLIssueNode>(
        octokit, ISSUES_SEARCH_QUERY, issueQ, `upstream-issues:${login}`, errors,
        (node) => extractRepoName(node),
        () => repoNames.size, CAP, "upstreamDiscovery",
      ),
      paginateGraphQLSearch<LightPRSearchResponse, GraphQLLightPRNode>(
        octokit, LIGHT_PR_SEARCH_QUERY, prQ, `upstream-prs:${login}`, errors,
        (node) => extractRepoName(node),
        () => repoNames.size, CAP, "upstreamDiscovery",
      ),
    ]);
  }

  // Collect all valid logins to discover for
  const logins: string[] = [];
  if (VALID_TRACKED_LOGIN.test(userLogin)) logins.push(userLogin);
  for (const u of trackedUsers ?? []) {
    if (VALID_TRACKED_LOGIN.test(u.login)) logins.push(u.login);
  }
  if (logins.length === 0) return [];

  // Process users sequentially so the repoNames.size cap check is atomic
  // across iterations (prevents TOCTOU race from parallel writes to the shared Set).
  // Issues + PRs searches for each user still run in parallel — they write to
  // the same Set within a single iteration, which is safe.
  for (const login of logins) {
    if (repoNames.size >= CAP) break;
    await discoverForUser(login);
  }

  if (errors.length > 0) {
    pushNotification(
      "upstream-discovery",
      `Upstream repo discovery partial failure — some repositories may be missing`,
      "warning"
    );
  }

  const repos: RepoRef[] = [];
  for (const fullName of repoNames) {
    const slash = fullName.indexOf("/");
    if (slash === -1) continue;
    repos.push({
      owner: fullName.slice(0, slash),
      name: fullName.slice(slash + 1),
      fullName,
    });
  }

  repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
  if (repos.length > CAP) repos.splice(CAP);
  return repos;
}

import { getClient, cachedRequest, updateGraphqlRateLimit } from "./github";
import * as Sentry from "@sentry/solid";
import { pushNotification, dismissNotificationBySource } from "../lib/errors";
import type { ApiCallSource } from "./api-usage";
import type { TrackedUser } from "../stores/config";
import { VALID_REPO_NAME, VALID_TRACKED_LOGIN, SEARCH_RESULT_CAP, APPROVE_PR_MUTATION, MARK_PR_READY_MUTATION, GITHUB_NODE_ID_RE, GIT_SHA_RE } from "../../shared/validation";
import { REPO_CAP, PR_ENRICHMENT_NOTIFICATION_SOURCE, PR_ENRICHMENT_DEGRADED_MESSAGE } from "../../shared/types";
import type { Issue, IssueState, PullRequest, PullRequestState, AutoMergeMethod, ViewerReviewState, WorkflowRun, RepoRef, RepoEntry, OrgEntry, CheckStatus, ApiError } from "../../shared/types";

// ── Re-exports from shared/types (backward compat for existing importers) ─────
export { REPO_CAP };
export type { Issue, IssueState, PullRequest, PullRequestState, AutoMergeMethod, ViewerReviewState, WorkflowRun, RepoRef, RepoEntry, OrgEntry, CheckStatus, ApiError, RateLimitInfo, DashboardSummary } from "../../shared/types";

// ── Types ────────────────────────────────────────────────────────────────────

interface GraphQLRateLimit {
  cost?: number;
  limit: number;
  remaining: number;
  resetAt: string;
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
  fork?: boolean;
  archived?: boolean;
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
export function isUnauthorizedError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; response?: { status?: unknown } };
  return e.status === 401 || e.response?.status === 401;
}

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
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
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

/**
 * Returns `err.data` (partial data GitHub sent alongside GraphQL errors) when
 * the rejection carries a data object, otherwise null.
 */
function extractPartialGraphqlData<T>(err: unknown): Partial<T> | null {
  return err && typeof err === "object" && "data" in err && err.data && typeof err.data === "object"
    ? err.data
    : null;
}

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
  const results = Array.from<PromiseSettledResult<T>>({ length: tasks.length });
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
  id: string;
  databaseId: number;
  number: number;
  title: string;
  state: IssueState;
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

export interface GraphQLRollupStateCount {
  state: string;
  count: number;
}

export interface GraphQLStatusCheckRollup {
  state: string;
  contexts?: {
    checkRunCountsByState?: GraphQLRollupStateCount[] | null;
  } | null;
}

const STATUS_CHECK_ROLLUP_FIELDS = `state contexts { checkRunCountsByState { state count } }`;

interface ForkCandidate {
  databaseId: number;
  headOwner: string;
  headRepo: string;
  sha: string;
}

interface ForkRepoResult {
  object: { statusCheckRollup: GraphQLStatusCheckRollup | null } | null;
}

interface ForkQueryResponse {
  rateLimit?: GraphQLRateLimit;
  [key: string]: ForkRepoResult | GraphQLRateLimit | undefined | null;
}

// ── GraphQL search query constants ───────────────────────────────────────────

const LIGHT_ISSUE_FRAGMENT = `
  fragment LightIssueFields on Issue {
    id
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
    rateLimit { cost limit remaining resetAt }
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
    rateLimit { cost limit remaining resetAt }
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
    rateLimit { cost limit remaining resetAt }
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
    rateLimit { cost limit remaining resetAt }
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

const BASE_PR_BACKFILL_FIELDS = `
        id
        databaseId
        headRefOid
        headRepository { owner { login } nameWithOwner }
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
        autoMergeRequest { mergeMethod }
        viewerLatestReview { state }
        viewerLatestReviewRequest { id }`;

/** Phase 2 backfill query: enriches PRs with heavy fields using node IDs. */
const HEAVY_PR_BACKFILL_QUERY = `
  query($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on PullRequest {${BASE_PR_BACKFILL_FIELDS}
        mergeStateStatus
        statusCheckRollup { ${STATUS_CHECK_ROLLUP_FIELDS} }
      }
    }
    rateLimit { cost limit remaining resetAt }
  }
`;

/** Lightweight backfill fallback query omitting mergeStateStatus and statusCheckRollup. */
const LIGHT_PR_BACKFILL_QUERY = `
  query($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on PullRequest {${BASE_PR_BACKFILL_FIELDS}
      }
    }
    rateLimit { cost limit remaining resetAt }
  }
`;

/** Hot-poll query: fetches current status fields for a batch of PR node IDs. */
const HOT_PR_STATUS_QUERY = `
  query($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on PullRequest {
        databaseId
        state
        isDraft
        updatedAt
        headRefOid
        mergeStateStatus
        reviewDecision
        autoMergeRequest { mergeMethod }
        viewerLatestReview { state }
        viewerLatestReviewRequest { id }
        statusCheckRollup { ${STATUS_CHECK_ROLLUP_FIELDS} }
        isCrossRepository
        headRef { target { ... on Commit { statusCheckRollup { ${STATUS_CHECK_ROLLUP_FIELDS} } } } }
      }
    }
    rateLimit { cost limit remaining resetAt }
  }
`;

interface HotPRStatusNode {
  databaseId: number;
  state: PullRequestState;
  isDraft?: boolean;
  updatedAt?: string;
  headRefOid?: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  autoMergeRequest?: { mergeMethod: string } | null;
  viewerLatestReview?: { state: string } | null;
  viewerLatestReviewRequest?: { id: string } | null;
  statusCheckRollup?: GraphQLStatusCheckRollup | null;
  isCrossRepository?: boolean;
  headRef?: { target?: { statusCheckRollup?: GraphQLStatusCheckRollup | null } | null } | null;
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
  state: PullRequestState;
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
  id?: string;
  databaseId: number;
  headRefOid: string;
  headRepository?: { owner?: { login: string } | null; nameWithOwner?: string | null } | null;
  mergeStateStatus?: string | null;
  assignees?: { nodes?: ({ login: string } | null)[] | null } | null;
  reviewRequests?: { nodes?: ({ requestedReviewer?: { login: string } | null } | null)[] | null } | null;
  latestReviews?: {
    totalCount?: number | null;
    nodes?: ({ author?: { login: string } | null } | null)[] | null;
  } | null;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  comments?: { totalCount?: number | null } | null;
  reviewThreads?: { totalCount?: number | null } | null;
  autoMergeRequest?: { mergeMethod: string } | null;
  viewerLatestReview?: { state: string } | null;
  viewerLatestReviewRequest?: { id: string } | null;
  statusCheckRollup?: GraphQLStatusCheckRollup | null;
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

export const HEAVY_BACKFILL_BATCH_SIZE = 25;
export const MIN_SPLIT_BATCH_SIZE = 6;
/**
 * Number of failed top-level heavy backfill batches, with no heavy node resolved
 * yet in the same fetchPREnrichment call, after which failing batches skip
 * binary splitting and go straight to the light fallback.
 */
export const SPLIT_SUPPRESSION_BATCH_THRESHOLD = 2;

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
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
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
    nodeId: node.id,
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
    if (pr.checkStatus !== null || pr.checkStatusStale) continue;
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
                statusCheckRollup { ${STATUS_CHECK_ROLLUP_FIELDS} }
              }
            }
          }`
      );
    }

    const forkQuery = `query(${varDefs.join(", ")}) {\n${fragments.join("\n")}\nrateLimit { cost limit remaining resetAt }\n}`;

    try {
      const forkResponse = await octokit.graphql<ForkQueryResponse>(forkQuery, { ...variables, request: { apiSource: "forkCheck" } });
      if (forkResponse.rateLimit) {
        updateGraphqlRateLimit(forkResponse.rateLimit);
      }

      for (let i = 0; i < forkChunk.length; i++) {
        const data = forkResponse[`fork${i}`] as ForkRepoResult | null | undefined;
        const rollup = data?.object?.statusCheckRollup ?? null;
        const pr = prMap.get(forkChunk[i].databaseId);
        if (pr) {
          pr.checkStatus = mapCheckStatus(rollup);
        }
      }
    } catch (err) {
      const errDataRaw = extractPartialGraphqlData<Record<string, unknown>>(err);
      if (errDataRaw?.rateLimit) {
        updateGraphqlRateLimit(errDataRaw.rateLimit as GraphQLRateLimit);
      }
      const partialData = errDataRaw as Record<string, ForkRepoResult | null | undefined> | null;

      for (let i = 0; i < forkChunk.length; i++) {
        const data = partialData?.[`fork${i}`];
        const pr = prMap.get(forkChunk[i].databaseId);
        if (!pr) continue;
        if (data) {
          const rollup = data.object?.statusCheckRollup ?? null;
          pr.checkStatus = mapCheckStatus(rollup);
        } else {
          pr.checkStatusStale = true;
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
  nodeIdMap: Map<number, string>,
  isViewerReviewRequested = false,
): boolean {
  if (node.databaseId == null || !node.repository) return false;
  if (prMap.has(node.databaseId)) {
    if (isViewerReviewRequested) {
      prMap.get(node.databaseId)!.viewerReviewRequested = true;
    }
    return false;
  }

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
    autoMergeMethod: null,
    viewerReviewRequested: isViewerReviewRequested,
    viewerLatestReviewState: null,
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
    const partial = extractPartialGraphqlData<LightCombinedSearchResponse>(err);
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
    processLightPRNode(node, prMap, nodeIdMap, source === "lightSearch");
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
      (node) => processLightPRNode(node, prMap, nodeIdMap, source === "lightSearch"),
      () => prMap.size, prCap, source, response.prReviewReq.pageInfo.endCursor,
    ));
  }
  if (prPaginationTasks.length > 0) {
    const paginationSettled = await Promise.allSettled(prPaginationTasks);
    for (const s of paginationSettled) {
      if (s.status === "rejected") {
        console.warn("[api] PR pagination task failed:", s.reason);
        Sentry.captureException(s.reason, { tags: { source: "pr-pagination" } });
      }
    }
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
      errors: [{ repo: "search", statusCode: null, message: `Invalid userLogin: "${userLogin}"`, retryable: false }],
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
    // archived:false drops items from repos archived since they were selected
    // (archived repos are read-only, so their PRs can't be acted on).
    const issueQ = `is:issue is:open archived:false involves:${userLogin} ${repoQualifiers}`;
    const prInvQ = `is:pr is:open archived:false involves:${userLogin} ${repoQualifiers}`;
    const prRevQ = `is:pr is:open archived:false review-requested:${userLogin} ${repoQualifiers}`;
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
    const issueQ = `is:issue is:open archived:false ${repoQualifiers}`;
    const prQ = `is:pr is:open archived:false ${repoQualifiers}`;
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
        const partial = extractPartialGraphqlData<UnfilteredSearchResponse>(err);
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
  checkStatusStale?: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  comments: number;
  reviewThreads: number;
  totalReviewCount: number;
  autoMergeMethod: AutoMergeMethod | null;
  viewerReviewRequested: boolean;
  viewerLatestReviewState: ViewerReviewState | null;
}

function mapHeavyPRNode(node: GraphQLHeavyPRNode, isLightFallback: boolean): PREnrichmentData {
  const pendingLogins = (node.reviewRequests?.nodes ?? [])
    .map((n) => n?.requestedReviewer?.login)
    .filter((l): l is string => l != null);
  const actualLogins = (node.latestReviews?.nodes ?? [])
    .map((n) => n?.author?.login)
    .filter((l): l is string => l != null);
  const reviewerLogins = [...new Set([...pendingLogins, ...actualLogins].map((l) => l.toLowerCase()))];

  const checkStatus = isLightFallback
    ? null
    : applyMergeStateOverride(
        node.mergeStateStatus ?? "",
        mapCheckStatus(node.statusCheckRollup ?? null),
      );

  let headRepository: PREnrichmentData["headRepository"] = null;
  if (node.headRepository?.nameWithOwner && node.headRepository.owner?.login) {
    const parts = node.headRepository.nameWithOwner.split("/");
    if (parts.length === 2) {
      headRepository = { owner: node.headRepository.owner.login, repoName: parts[1] };
    }
  }

  return {
    id: node.databaseId,
    headSha: node.headRefOid,
    headRepository,
    assigneeLogins: (node.assignees?.nodes ?? [])
      .map((a) => a?.login)
      .filter((l): l is string => l != null),
    reviewerLogins,
    checkStatus,
    ...(isLightFallback ? { checkStatusStale: true } : {}),
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    changedFiles: node.changedFiles ?? 0,
    comments: node.comments?.totalCount ?? 0,
    reviewThreads: node.reviewThreads?.totalCount ?? 0,
    totalReviewCount: node.latestReviews?.totalCount ?? 0,
    autoMergeMethod: mapAutoMergeMethod(node.autoMergeRequest?.mergeMethod),
    viewerReviewRequested: Boolean(node.viewerLatestReviewRequest?.id),
    viewerLatestReviewState: mapViewerReviewState(node.viewerLatestReview?.state),
  };
}

function extractErroredNodeIndices(err: unknown): ReadonlySet<number> {
  const indices = new Set<number>();
  if (!err || typeof err !== "object" || !("errors" in err) || !Array.isArray(err.errors)) {
    return indices;
  }
  for (const e of err.errors) {
    if (!e || typeof e !== "object" || !("path" in e)) continue;
    const path = (e as { path?: unknown }).path;
    if (
      Array.isArray(path) &&
      path[0] === "nodes" &&
      typeof path[1] === "number" &&
      Number.isInteger(path[1]) &&
      path[1] >= 0
    ) {
      indices.add(path[1]);
    }
  }
  return indices;
}

/** ApiError.repo prefix for phase-2 PR enrichment (backfill) batch failures. */
const BACKFILL_ERROR_PREFIX = "backfill-batch-";

export function isBackfillError(e: Pick<ApiError, "repo">): boolean {
  return e.repo.startsWith(BACKFILL_ERROR_PREFIX);
}

/** True when any PR lacks enrichment or has unverified CI check status. */
export function hasDegradedEnrichment(
  prs: readonly Pick<PullRequest, "enriched" | "checkStatusStale">[],
): boolean {
  return prs.some((pr) => pr.enriched === false || pr.checkStatusStale === true);
}

/** Pushes the persistent, toast-silent "PR details degraded" warning. */
export function pushEnrichmentDegraded(): void {
  pushNotification(
    PR_ENRICHMENT_NOTIFICATION_SOURCE,
    PR_ENRICHMENT_DEGRADED_MESSAGE,
    "warning",
    true,
    undefined,
    { silentToast: true },
  );
}

/**
 * Phase 2: fetches heavy PR fields using `nodes(ids: [...])` query.
 * Chunks requests into HEAVY_BACKFILL_BATCH_SIZE batches, recursively splits batches
 * that fail with a retryable error in half down to MIN_SPLIT_BATCH_SIZE, and falls back
 * to LIGHT_PR_BACKFILL_QUERY on leaf failures. Retryable failures include browser
 * `TypeError: Failed to fetch`, which is how CORS-masked GitHub gateway 502/504 timeouts
 * surface. Once SPLIT_SUPPRESSION_BATCH_THRESHOLD batches have failed in this call without
 * any heavy node resolving, failing batches skip splitting and go straight to the light
 * fallback, so a broad outage costs about one heavy and one light request per batch.
 * Returns enrichment data keyed by databaseId.
 */
export async function fetchPREnrichment(
  octokit: GitHubOctokit,
  nodeIds: string[]
): Promise<{ enrichments: Map<number, PREnrichmentData>; errors: ApiError[] }> {
  const enrichments = new Map<number, PREnrichmentData>();
  const errors: ApiError[] = [];

  if (nodeIds.length === 0) return { enrichments, errors };

  const batches = chunkArray(nodeIds, HEAVY_BACKFILL_BATCH_SIZE);
  let heavyNodesResolved = 0;
  let failedBatchCount = 0;
  await Promise.allSettled(
    batches.map(async (batch, batchIdx) => {
      const resolvedNodeIds = new Set<string>();
      const batchLabel = `${batchIdx + 1}/${batches.length}`;
      let batchErrorPushed = false;
      let batchFailed = false;

      const ingestBackfillPayload = (
        payload: Partial<HeavyBackfillResponse> | null | undefined,
        isLightFallback: boolean,
        erroredIndices?: ReadonlySet<number>,
      ): void => {
        if (!payload) return;
        if (payload.rateLimit) {
          updateGraphqlRateLimit(payload.rateLimit);
        }
        if (Array.isArray(payload.nodes)) {
          for (const [idx, node] of payload.nodes.entries()) {
            if (!node || node.databaseId == null || erroredIndices?.has(idx)) continue;
            enrichments.set(node.databaseId, mapHeavyPRNode(node, isLightFallback));
            if (!isLightFallback) heavyNodesResolved++;
            if (node.id) resolvedNodeIds.add(node.id);
          }
        }
      };

      const reportBatchFailure = (
        err: unknown,
        statusCode: number | null,
        message: string,
        retryable: boolean,
      ): void => {
        if (batchErrorPushed) return;
        batchErrorPushed = true;
        console.warn(`[api] PR enrichment batch ${batchLabel} failed:`, err);
        Sentry.captureException(err, { tags: { source: "prEnrichment" } });
        errors.push({ repo: `${BACKFILL_ERROR_PREFIX}${batchLabel}`, statusCode, message, retryable });
      };

      const fetchBatchWithSplit = async (batchIds: string[]): Promise<void> => {
        try {
          const response = await octokit.graphql<HeavyBackfillResponse>(HEAVY_PR_BACKFILL_QUERY, {
            ids: batchIds,
            request: {
              apiSource: "heavyBackfill",
              retries: 0,
            },
          });

          ingestBackfillPayload(response, false);
        } catch (err) {
          ingestBackfillPayload(
            extractPartialGraphqlData<HeavyBackfillResponse>(err),
            false,
            extractErroredNodeIndices(err),
          );

          const remainingIds = batchIds.filter((id) => !resolvedNodeIds.has(id));
          if (remainingIds.length === 0) return;

          if (!batchFailed) {
            batchFailed = true;
            failedBatchCount++;
          }

          const { statusCode, message } = extractRejectionError(err);
          const retryable = statusCode === null || statusCode >= 500;

          if (!retryable) {
            reportBatchFailure(err, statusCode, message, false);
            return;
          }

          const canSplit =
            heavyNodesResolved > 0 || failedBatchCount < SPLIT_SUPPRESSION_BATCH_THRESHOLD;

          if (canSplit && remainingIds.length > MIN_SPLIT_BATCH_SIZE) {
            const mid = Math.floor(remainingIds.length / 2);
            await Promise.allSettled([
              fetchBatchWithSplit(remainingIds.slice(0, mid)),
              fetchBatchWithSplit(remainingIds.slice(mid)),
            ]);
            return;
          }

          if (canSplit && batchIds.length > MIN_SPLIT_BATCH_SIZE && remainingIds.length < batchIds.length) {
            await fetchBatchWithSplit(remainingIds);
            return;
          }

          reportBatchFailure(err, statusCode, message, true);

          try {
            const lightResponse = await octokit.graphql<HeavyBackfillResponse>(LIGHT_PR_BACKFILL_QUERY, {
              ids: remainingIds,
              request: { apiSource: "heavyBackfill", retries: 0 },
            });
            ingestBackfillPayload(lightResponse, true);
          } catch (lightErr) {
            ingestBackfillPayload(
              extractPartialGraphqlData<HeavyBackfillResponse>(lightErr),
              true,
              extractErroredNodeIndices(lightErr),
            );
          }
        }
      };

      await fetchBatchWithSplit(batch);
    }),
  );

  return { enrichments, errors };
}

// ── Body-fetch timeout guard ────────────────────────────────────────────────
// Prevents a hung request (e.g. octokit's secondary-rate-limit retry logic
// stalling indefinitely) from wedging the caller's fetch-in-progress gate.

export const GRAPHQL_BODY_FETCH_TIMEOUT_MS = 45_000;
export const BODY_FETCH_BATCH_SIZE = 25;
export const BODY_FETCH_NOTIFICATION_THRESHOLD = 3;

const _consecutiveBodyFetchFailures = new Map<string, number>();

export function resetBodyFetchFailures(source?: string): void {
  if (source !== undefined) {
    _consecutiveBodyFetchFailures.delete(source);
    dismissNotificationBySource(source);
    return;
  }
  for (const s of _consecutiveBodyFetchFailures.keys()) {
    dismissNotificationBySource(s);
  }
  _consecutiveBodyFetchFailures.clear();
}

export class GraphqlFetchTimeoutError extends Error {
  override readonly name = "GraphqlFetchTimeoutError";
}

export function raceWithTimeout<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new GraphqlFetchTimeoutError(`GraphQL request exceeded ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

interface NodeBodiesResponse<TNode> {
  nodes: Array<TNode | null>;
  rateLimit?: GraphQLRateLimit;
}

export interface NodeBodiesFetchResult<K, V> {
  bodies: Map<K, V>;
  /** Requested node IDs belonging to a batch that errored or timed out. */
  failedIds: Set<string>;
}

/**
 * Shared batched-fetch helper for GraphQL `nodes()` queries that pull a single
 * field (e.g. issue/PR body text) for a set of node IDs. Chunks ids into
 * BODY_FETCH_BATCH_SIZE batches, races each sub-batch via raceWithTimeout,
 * salvages partial err.data.nodes on error, recursively binary-splits retryable
 * batch failures (5xx, GraphQL errors, or `Failed to fetch`; not a raceWithTimeout
 * abort) down to MIN_SPLIT_BATCH_SIZE, and reports failures via
 * console.warn + Sentry (capped at once per top-level batch) + a silent
 * Notification Drawer warning after BODY_FETCH_NOTIFICATION_THRESHOLD
 * consecutive failing calls for a source.
 *
 * `mapNode` lets each caller decide how to fold a raw node into the result map
 * (e.g. whether to keep or skip a null body) without duplicating the batching,
 * timeout, rate-limit, and error-reporting plumbing. Leaf sub-batches or
 * non-retryable batches that fail contribute their unresolved ids to `failedIds`
 * so callers can avoid retrying a persistently-failing id on every poll cycle.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
async function fetchNodeBodiesBatched<TNode extends { id?: string | null }, K, V>(
  octokit: GitHubOctokit,
  nodeIds: string[],
  query: string,
  source: string,
  notificationMessage: string,
  mapNode: (node: TNode, bodies: Map<K, V>) => void,
): Promise<NodeBodiesFetchResult<K, V>> {
  const bodies = new Map<K, V>();
  const failedIds = new Set<string>();
  if (nodeIds.length === 0) return { bodies, failedIds };

  const batches = chunkArray(nodeIds, BODY_FETCH_BATCH_SIZE);
  await Promise.allSettled(batches.map(async (batch) => {
    const batchStart = Date.now();
    console.debug(`[api] ${source} batch started (${batch.length} ids) at ${batchStart}`);
    const resolvedNodeIds = new Set<string>();
    let batchErrorPushed = false;

    const ingestBodyPayload = (
      payload: Partial<NodeBodiesResponse<TNode>> | null | undefined,
      resolvedSubBatchIds?: string[],
    ): void => {
      if (!payload) return;
      if (payload.rateLimit) updateGraphqlRateLimit(payload.rateLimit);
      if (Array.isArray(payload.nodes)) {
        for (const node of payload.nodes) {
          if (!node) continue;
          mapNode(node, bodies);
          if (node.id) resolvedNodeIds.add(node.id);
        }
      }
      if (resolvedSubBatchIds) {
        for (const id of resolvedSubBatchIds) {
          resolvedNodeIds.add(id);
        }
      }
    };

    const fetchBatchWithSplit = async (batchIds: string[], isSplitRetry: boolean): Promise<void> => {
      const controller = new AbortController();
      try {
        const response = await raceWithTimeout(
          octokit.graphql<NodeBodiesResponse<TNode>>(
            query,
            {
              ids: batchIds,
              request: {
                apiSource: source,
                signal: controller.signal,
                retries: isSplitRetry || batchIds.length > MIN_SPLIT_BATCH_SIZE ? 0 : 1,
              },
            },
          ),
          GRAPHQL_BODY_FETCH_TIMEOUT_MS,
          controller,
        );
        ingestBodyPayload(response, batchIds);
      } catch (err) {
        ingestBodyPayload(extractPartialGraphqlData<NodeBodiesResponse<TNode>>(err));

        const remainingIds = batchIds.filter((id) => !resolvedNodeIds.has(id));
        if (remainingIds.length === 0) return;

        const { statusCode } = extractRejectionError(err);
        const retryable = (statusCode === null || statusCode >= 500) && !controller.signal.aborted;

        if (retryable && remainingIds.length > MIN_SPLIT_BATCH_SIZE) {
          const mid = Math.floor(remainingIds.length / 2);
          await Promise.allSettled([
            fetchBatchWithSplit(remainingIds.slice(0, mid), true),
            fetchBatchWithSplit(remainingIds.slice(mid), true),
          ]);
          return;
        }

        for (const id of remainingIds) failedIds.add(id);
        if (!batchErrorPushed) {
          batchErrorPushed = true;
          console.warn(`[api] ${source} batch failed or timed out:`, err);
          Sentry.captureException(err, { tags: { source } });
        }
      }
    };

    try {
      await fetchBatchWithSplit(batch, false);
    } finally {
      console.debug(`[api] ${source} batch settled after ${Date.now() - batchStart}ms`);
    }
  }));

  if (getClient() === octokit) {
    if (failedIds.size > 0) {
      const consecutive = (_consecutiveBodyFetchFailures.get(source) ?? 0) + 1;
      _consecutiveBodyFetchFailures.set(source, consecutive);
      if (consecutive >= BODY_FETCH_NOTIFICATION_THRESHOLD) {
        pushNotification(source, notificationMessage, "warning", true, undefined, { silentToast: true });
      }
    } else {
      resetBodyFetchFailures(source);
    }
  }

  return { bodies, failedIds };
}

// ── Dashboard issue body fetch ────────────────────────────────────────────────

const DASHBOARD_ISSUE_BODIES_QUERY = `
  query($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Issue { id body }
    }
    rateLimit { cost limit remaining resetAt }
  }
`;

interface DashboardIssueBodyNode {
  id: string;
  body: string | null;
}

/** Fetches issue bodies for Dashboard issues by node ID (single nodes() batch query). */
export async function fetchDashboardIssueBodies(
  octokit: GitHubOctokit,
  issueNodeIds: string[]
): Promise<NodeBodiesFetchResult<string, string | null>> {
  return fetchNodeBodiesBatched<DashboardIssueBodyNode, string, string | null>(
    octokit,
    issueNodeIds,
    DASHBOARD_ISSUE_BODIES_QUERY,
    "dashboardBodies",
    "Some dependency dashboard data could not be loaded",
    (node, bodies) => {
      if (!node.id) return;
      bodies.set(node.id, node.body);
    },
  );
}

// ── Dependency PR body fetch ─────────────────────────────────────────────────

const DEP_PR_BODIES_QUERY = `
  query($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on PullRequest { id databaseId body }
    }
    rateLimit { cost limit remaining resetAt }
  }
`;

interface DepPRBodyNode {
  id?: string;
  databaseId: number;
  body: string | null;
}

export async function fetchDepPRBodies(
  octokit: GitHubOctokit,
  prNodeIds: string[]
): Promise<NodeBodiesFetchResult<number, string>> {
  return fetchNodeBodiesBatched<DepPRBodyNode, number, string>(
    octokit,
    prNodeIds,
    DEP_PR_BODIES_QUERY,
    "depPRBodies",
    "Some dependency PR types could not be determined — badges may be missing",
    (node, bodies) => {
      if (node.databaseId == null || !node.body) return;
      bodies.set(node.databaseId, node.body);
    },
  );
}

/**
 * The heavy PR fields populated by phase-2 enrichment. Centralized so the sites
 * that copy enrichment onto a PR — mergeEnrichment, fallbackToPreviousEnrichment,
 * and the fine-grained store merge in DashboardPage — stay in sync when a field
 * is added or removed.
 */
type EnrichmentFields = Pick<
  PullRequest,
  | "headSha"
  | "assigneeLogins"
  | "reviewerLogins"
  | "checkStatus"
  | "checkStatusStale"
  | "additions"
  | "deletions"
  | "changedFiles"
  | "comments"
  | "reviewThreads"
  | "totalReviewCount"
  | "autoMergeMethod"
  | "viewerReviewRequested"
  | "viewerLatestReviewState"
>;

/** Extracts just the heavy enrichment fields from any PR-shaped source. */
export function pickEnrichmentFields(source: EnrichmentFields): EnrichmentFields {
  return {
    headSha: source.headSha,
    assigneeLogins: source.assigneeLogins,
    reviewerLogins: source.reviewerLogins,
    checkStatus: source.checkStatus,
    ...(source.checkStatusStale !== undefined ? { checkStatusStale: source.checkStatusStale } : {}),
    additions: source.additions,
    deletions: source.deletions,
    changedFiles: source.changedFiles,
    comments: source.comments,
    reviewThreads: source.reviewThreads,
    totalReviewCount: source.totalReviewCount,
    autoMergeMethod: source.autoMergeMethod,
    viewerReviewRequested: source.viewerReviewRequested,
    viewerLatestReviewState: source.viewerLatestReviewState,
  };
}

type RevisionFields = Pick<PullRequest, "headSha" | "updatedAt">;

/**
 * True when two snapshots of a PR are at the same revision: compares headSha
 * when both are known, otherwise falls back to updatedAt.
 */
export function isSameRevision(a: RevisionFields, b: RevisionFields): boolean {
  return a.headSha && b.headSha ? a.headSha === b.headSha : a.updatedAt === b.updatedAt;
}

/**
 * True when a PR may have moved to a new revision: updatedAt differs, or both
 * headShas are known and differ.
 */
export function hasRevisionChanged(a: RevisionFields, b: RevisionFields): boolean {
  return a.updatedAt !== b.updatedAt || (Boolean(a.headSha) && Boolean(b.headSha) && a.headSha !== b.headSha);
}

/**
 * Clears a PR's headSha and check status and sets checkStatusStale, so CI is
 * treated as unverified until the hot poll or the next backfill resolves the
 * current revision. Mutates and returns `pr`.
 */
export function markCheckStatusStale<T extends Pick<PullRequest, "headSha" | "checkStatus" | "checkStatusStale">>(pr: T): T {
  pr.headSha = "";
  pr.checkStatus = null;
  pr.checkStatusStale = true;
  return pr;
}

/**
 * Merges phase 2 enrichment data into light PRs. Returns enriched PR array.
 * Also detects fork PRs for the statusCheckRollup fallback.
 */
function mergeEnrichment(
  lightPRs: PullRequest[],
  enrichments: Map<number, PREnrichmentData>,
  forkInfoMap: Map<number, { owner: string; repoName: string }>,
  viewerLogin = "",
  skipForkIds?: ReadonlySet<number>,
): PullRequest[] {
  return lightPRs.map((pr) => {
    const e = enrichments.get(pr.id);
    if (!e) return pr; // Keep enriched: false if backfill missed this PR

    if (e.headRepository && !skipForkIds?.has(pr.id)) {
      forkInfoMap.set(pr.id, e.headRepository);
    }

    const viewerReviewRequested =
      e.viewerLatestReviewState === "APPROVED" && !e.viewerReviewRequested
        ? false
        : (pr.viewerReviewRequested ?? false) || e.viewerReviewRequested;
    const reviewerLogins =
      viewerLogin &&
      (viewerReviewRequested || e.viewerLatestReviewState !== null) &&
      !e.reviewerLogins.includes(viewerLogin)
        ? [...e.reviewerLogins, viewerLogin]
        : e.reviewerLogins;

    return {
      ...pr,
      ...pickEnrichmentFields(e),
      reviewerLogins,
      viewerReviewRequested,
      enriched: true,
    };
  });
}

/**
 * Carries forward a PR's last-known enrichment when this cycle's backfill
 * failed for it, instead of regressing an already-enriched PR to unenriched.
 * Without this, a single transient backfill failure wipes size/check-status
 * data and can flip dependency-status classification (e.g. Mergeable ->
 * Needs Action) until the next successful poll re-enriches it.
 */
export function fallbackToPreviousEnrichment(
  previous: PullRequest[],
  next: PullRequest[]
): PullRequest[] {
  if (previous.length === 0) return next;
  const previousMap = new Map(previous.map((pr) => [pr.id, pr]));
  return next.map((pr) => {
    if (pr.enriched !== false) {
      if (pr.checkStatusStale) {
        const prev = previousMap.get(pr.id);
        if (prev && prev.enriched !== false && !prev.checkStatusStale && isSameRevision(prev, pr)) {
          return { ...pr, checkStatus: prev.checkStatus, checkStatusStale: false };
        }
        return { ...pr, checkStatus: null, checkStatusStale: true };
      }
      return pr;
    }
    const prev = previousMap.get(pr.id);
    if (!prev || prev.enriched === false) return pr;
    if (hasRevisionChanged(prev, pr) || prev.checkStatusStale) {
      return markCheckStatusStale({ ...pr, ...pickEnrichmentFields(prev), enriched: true });
    }
    return {
      ...pr,
      ...pickEnrichmentFields(prev),
      enriched: true,
    };
  });
}

// ── Settled-PR enrichment cache (TTL = refresh interval + 60s, min 3 minutes) ─

/** Floor for the settled-PR enrichment cache TTL; also applies when auto-refresh is off. */
export const MIN_ENRICHMENT_CACHE_TTL_MS = 3 * 60 * 1000;
/** Added to the refresh interval so the next scheduled poll (±30s jitter) lands inside the TTL. */
const ENRICHMENT_CACHE_TTL_MARGIN_MS = 60 * 1000;

let _enrichmentCacheTtlMs = MIN_ENRICHMENT_CACHE_TTL_MS;

/**
 * Sets the settled-PR enrichment cache TTL to the full-refresh interval plus
 * ENRICHMENT_CACHE_TTL_MARGIN_MS, floored at MIN_ENRICHMENT_CACHE_TTL_MS, so an
 * entry written by one scheduled poll is still valid on the next one. An
 * interval of 0 (auto-refresh off) uses the floor.
 */
export function setPREnrichmentCacheRefreshInterval(refreshIntervalSec: number): void {
  const derivedMs = refreshIntervalSec > 0 ? refreshIntervalSec * 1000 + ENRICHMENT_CACHE_TTL_MARGIN_MS : 0;
  _enrichmentCacheTtlMs = Math.max(MIN_ENRICHMENT_CACHE_TTL_MS, derivedMs);
}

interface CachedPREnrichment {
  userLogin: string;
  updatedAt: string;
  fetchedAt: number;
  repoFullName: string;
  enrichment: PREnrichmentData;
}

const _prEnrichmentCache = new Map<string, CachedPREnrichment>();
let _enrichmentCacheGen = 0;

export function resetPREnrichmentCache(): void {
  _enrichmentCacheGen++;
  _prEnrichmentCache.clear();
  resetBodyFetchFailures();
}

export function invalidatePREnrichmentCacheForRepos(repoFullNames: Iterable<string>): void {
  const targets = new Set<string>();
  for (const name of repoFullNames) {
    targets.add(name.toLowerCase());
  }
  if (targets.size === 0) return;
  _enrichmentCacheGen++;
  for (const [nodeId, entry] of _prEnrichmentCache) {
    if (targets.has(entry.repoFullName.toLowerCase())) {
      _prEnrichmentCache.delete(nodeId);
    }
  }
}

export function evictPREnrichmentCacheNode(nodeId: string | undefined): void {
  if (nodeId) {
    _enrichmentCacheGen++;
    _prEnrichmentCache.delete(nodeId);
  }
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

export interface FetchIssuesAndPRsOptions {
  onLightData?: (data: FetchIssuesAndPRsResult) => void;
  trackedUsers?: TrackedUser[];
  monitoredRepos?: RepoRef[];
  /** Bypasses the settled-PR enrichment cache. */
  force?: boolean;
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
  options: FetchIssuesAndPRsOptions = {},
): Promise<FetchIssuesAndPRsResult> {
  const { onLightData, trackedUsers, monitoredRepos, force = false } = options;
  if (!octokit) throw new Error("No GitHub client available");

  const cacheGen = _enrichmentCacheGen;
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
  const cachedEnrichments = new Map<number, PREnrichmentData>();
  const cachedPrIds = new Set<number>();

  const tryGetCachedEnrichment = (pr: PullRequest, nodeId: string): PREnrichmentData | null => {
    if (force) return null;
    const cached = _prEnrichmentCache.get(nodeId);
    if (
      cached &&
      cached.userLogin === normalizedLogin &&
      cached.updatedAt === pr.updatedAt &&
      !cached.enrichment.checkStatusStale &&
      !isNonTerminalCheckStatus(cached.enrichment.checkStatus) &&
      Date.now() - cached.fetchedAt < _enrichmentCacheTtlMs
    ) {
      return cached.enrichment;
    }
    return null;
  };

  // Phase 1: main user light search over normalRepos (those not in monitoredRepos)
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

  // Main user node IDs known — check settled-PR cache first, then start backfill
  // in parallel with tracked user searches.
  const mainNodeIds: string[] = [];
  for (const pr of prMap.values()) {
    const nodeId = nodeIdMap.get(pr.id);
    if (!nodeId) continue;
    const cached = tryGetCachedEnrichment(pr, nodeId);
    if (cached) {
      cachedEnrichments.set(pr.id, cached);
      cachedPrIds.add(pr.id);
    } else {
      mainNodeIds.push(nodeId);
    }
  }
  const mainBackfillPromise = mainNodeIds.length > 0
    ? fetchPREnrichment(octokit, mainNodeIds)
    : Promise.resolve({ enrichments: new Map<number, PREnrichmentData>(), errors: [] as ApiError[] });

  // Tracked user searches — scoped to normalRepos only. Monitored repos are already
  // covered by graphqlUnfilteredSearch (all open items, no user qualifier), so running
  // involves: on them would duplicate work and add spurious surfacedBy annotations.
  // Bot users get both base and [bot] variant searches for coverage.
  const trackedSearchTasks: { login: string; promise: Promise<LightSearchResult> }[] = [];
  if (hasTrackedUsers && normalRepos.length > 0) {
    for (const u of trackedUsers!) {
      trackedSearchTasks.push({ login: u.login, promise: graphqlLightCombinedSearch(octokit, normalRepos, u.login, "globalUserSearch") });
      if (u.type === "bot") {
        const botVariant = `${u.login}[bot]`;
        trackedSearchTasks.push({ login: u.login, promise: graphqlLightCombinedSearch(octokit, normalRepos, botVariant, "globalUserSearch") });
      }
    }
  }
  const trackedSearchPromise = trackedSearchTasks.length > 0
    ? Promise.allSettled(trackedSearchTasks.map((t) => t.promise))
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
  if (trackedSearchTasks.length > 0) {
    const settled = trackedResults;
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      const trackedLogin = trackedSearchTasks[i].login;
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

  // Delta backfill: enrich PRs not already covered by main backfill —
  // includes both monitored repo PRs and new PRs from tracked users
  const deltaNodeIds: string[] = [];
  for (const pr of mergedPRs) {
    if (!preNewPrIds.has(pr.id)) {
      const nodeId = nodeIdMap.get(pr.id);
      if (!nodeId) continue;
      const cached = tryGetCachedEnrichment(pr, nodeId);
      if (cached) {
        cachedEnrichments.set(pr.id, cached);
        cachedPrIds.add(pr.id);
      } else {
        deltaNodeIds.push(nodeId);
      }
    }
  }

  // Apply cached enrichments (skipping forkInfoMap population for already-resolved cached fork PRs)
  let enrichedPRs = cachedEnrichments.size > 0
    ? mergeEnrichment(mergedPRs, cachedEnrichments, forkInfoMap, normalizedLogin, cachedPrIds)
    : mergedPRs;

  // Apply main backfill enrichments
  if (mainBackfill.enrichments.size > 0) {
    enrichedPRs = mergeEnrichment(enrichedPRs, mainBackfill.enrichments, forkInfoMap, normalizedLogin);
  }

  let deltaEnrichments = new Map<number, PREnrichmentData>();
  if (deltaNodeIds.length > 0) {
    const delta = await fetchPREnrichment(octokit, deltaNodeIds);
    deltaEnrichments = delta.enrichments;
    backfillErrors.push(...delta.errors);
    enrichedPRs = mergeEnrichment(enrichedPRs, delta.enrichments, forkInfoMap, normalizedLogin);
  }

  // Fork PR fallback for enriched PRs
  const enrichedPRMap = new Map(enrichedPRs.map(pr => [pr.id, pr]));
  await runForkPRFallback(octokit, enrichedPRMap, forkInfoMap);

  if (cacheGen === _enrichmentCacheGen && (getClient() === octokit || getClient() == null)) {
    const now = Date.now();
    const freshEnrichments = new Map<number, PREnrichmentData>([
      ...mainBackfill.enrichments,
      ...deltaEnrichments,
    ]);
    for (const [prId, rawEnrichment] of freshEnrichments) {
      const finalPr = enrichedPRMap.get(prId);
      const nodeId = nodeIdMap.get(prId);
      if (finalPr && nodeId && !finalPr.checkStatusStale && !isNonTerminalCheckStatus(finalPr.checkStatus)) {
        _prEnrichmentCache.set(nodeId, {
          userLogin: normalizedLogin,
          updatedAt: finalPr.updatedAt,
          fetchedAt: now,
          repoFullName: finalPr.repoFullName,
          enrichment: {
            ...rawEnrichment,
            checkStatus: finalPr.checkStatus,
            checkStatusStale: undefined,
          },
        });
      }
    }
    const polledRepoSet = new Set(repos.map((r) => r.fullName.toLowerCase()));
    const activeNodeIds = allErrors.length === 0 ? new Set(nodeIdMap.values()) : null;
    for (const [nodeId, entry] of _prEnrichmentCache) {
      if (now - entry.fetchedAt >= _enrichmentCacheTtlMs) {
        _prEnrichmentCache.delete(nodeId);
      } else if (
        activeNodeIds &&
        polledRepoSet.has(entry.repoFullName.toLowerCase()) &&
        !activeNodeIds.has(nodeId)
      ) {
        _prEnrichmentCache.delete(nodeId);
      }
    }
  }

  return {
    issues: mergedIssues,
    pullRequests: [...enrichedPRMap.values()],
    errors: [...allErrors, ...backfillErrors],
  };
}

/**
 * True when a PR's checkStatus is non-terminal ("running", "waiting", or "pending"),
 * meaning CI has not reached a settled pass/fail/conflict state.
 */
export function isNonTerminalCheckStatus(status: CheckStatus["status"]): boolean {
  return status === "running" || status === "waiting" || status === "pending";
}

/**
 * Maps a GraphQL statusCheckRollup object (or state string) to the app's CheckStatus["status"].
 * Non-terminal rollups (PENDING / EXPECTED / QUEUED) inspect contexts.checkRunCountsByState:
 * - IN_PROGRESS > 0 -> "running"
 * - WAITING > 0 or ACTION_REQUIRED > 0 -> "waiting"
 * - otherwise (e.g. QUEUED > 0, pending StatusContext, or omitted contexts) -> "pending"
 */
function mapCheckStatus(rollup: GraphQLStatusCheckRollup | string | null | undefined): CheckStatus["status"] {
  const state = typeof rollup === "string" ? rollup : rollup?.state ?? null;
  if (state === "FAILURE" || state === "ERROR" || state === "ACTION_REQUIRED") return "failure";
  if (state === "SUCCESS") return "success";
  if (state === "PENDING" || state === "EXPECTED" || state === "QUEUED") {
    const checkRunCounts =
      typeof rollup === "object" && rollup !== null
        ? rollup.contexts?.checkRunCountsByState
        : undefined;
    if (Array.isArray(checkRunCounts)) {
      if (checkRunCounts.some((c) => c.state === "IN_PROGRESS" && c.count > 0)) return "running";
      if (
        checkRunCounts.some(
          (c) => (c.state === "WAITING" || c.state === "ACTION_REQUIRED") && c.count > 0,
        )
      ) {
        return "waiting";
      }
      return "pending";
    }
    return "pending";
  }
  return null;
}

/**
 * Applies mergeStateStatus overrides to a PR's checkStatus.
 * DIRTY/BEHIND → conflict. UNSTABLE → failure unless checkStatus is non-terminal
 * ("running", "waiting", or "pending"), since a non-terminal rollup means checks
 * are still active or awaiting action/conditions rather than conclusively failed.
 * All other values (CLEAN, BLOCKED, HAS_HOOKS, UNKNOWN) pass through unchanged.
 */
function applyMergeStateOverride(
  mergeStateStatus: string | null | undefined,
  checkStatus: CheckStatus["status"],
): CheckStatus["status"] {
  if (mergeStateStatus === "DIRTY" || mergeStateStatus === "BEHIND") return "conflict";
  if (mergeStateStatus === "UNSTABLE" && !isNonTerminalCheckStatus(checkStatus)) return "failure";
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

function mapAutoMergeMethod(raw: string | null | undefined): AutoMergeMethod | null {
  if (raw === "MERGE" || raw === "SQUASH" || raw === "REBASE") return raw;
  return null;
}

function mapViewerReviewState(raw: string | null | undefined): ViewerReviewState | null {
  if (
    raw === "APPROVED" ||
    raw === "CHANGES_REQUESTED" ||
    raw === "COMMENTED" ||
    raw === "DISMISSED" ||
    raw === "PENDING"
  ) {
    return raw;
  }
  return null;
}

// ── Step 1: fetchOrgs ────────────────────────────────────────────────────────

/**
 * Returns orgs and the personal user account. Personal account is first.
 * Fully paginates GET /user/orgs — a single-page fetch would silently
 * truncate at 100 orgs for heavily-affiliated accounts.
 */
export async function fetchOrgs(
  octokit: ReturnType<typeof getClient>
): Promise<OrgEntry[]> {
  if (!octokit) throw new Error("No GitHub client available");

  const userPromise = cachedRequest(octokit, "orgs:user", "GET /user");

  const orgEntries: OrgEntry[] = [];
  const ORG_CAP = 1000;
  for await (const response of octokit.paginate.iterator("GET /user/orgs", {
    per_page: 100,
  })) {
    for (const org of response.data as RawOrg[]) {
      orgEntries.push({ login: org.login, avatarUrl: org.avatar_url, type: "org" });
    }
    if (orgEntries.length >= ORG_CAP) break;
  }

  const userResult = await userPromise;
  const user = userResult.data as RawUser;

  const personal: OrgEntry = {
    login: user.login,
    avatarUrl: user.avatar_url,
    type: "user",
  };

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
        if (repo.archived) continue;
        repos.push({
          owner: repo.owner.login,
          name: repo.name,
          fullName: repo.full_name,
          pushedAt: repo.pushed_at ?? null,
          isFork: Boolean(repo.fork),
        });
        if (repos.length >= REPO_CAP) break;
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
        if (repo.archived) continue;
        repos.push({
          owner: repo.owner.login,
          name: repo.name,
          fullName: repo.full_name,
          pushedAt: repo.pushed_at ?? null,
          isFork: Boolean(repo.fork),
        });
        if (repos.length >= REPO_CAP) break;
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
      const sorted = workflowRuns.toSorted(
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
  state: PullRequestState;
  draft?: boolean;
  updatedAt?: string;
  checkStatus: CheckStatus["status"];
  mergeStateStatus: string;
  reviewDecision: PullRequest["reviewDecision"];
  headSha?: string;
  autoMergeMethod?: AutoMergeMethod | null;
  viewerReviewRequested?: boolean;
  viewerLatestReviewState?: ViewerReviewState | null;
}

/**
 * Fetches current status fields (check status, review decision, state) for a
 * batch of PR node IDs using the nodes() GraphQL query. Returns a map keyed
 * by databaseId. Uses Promise.allSettled per batch and salvages resolved nodes
 * from a failed batch's partial data (skipping errored node indices).
 */
export async function fetchHotPRStatus(
  octokit: GitHubOctokit,
  nodeIds: string[],
  options?: { reportToSentry?: boolean }
): Promise<{ results: Map<number, HotPRStatusUpdate>; hadErrors: boolean }> {
  const results = new Map<number, HotPRStatusUpdate>();
  if (nodeIds.length === 0) return { results, hadErrors: false };

  // Same batch size as heavy backfill: HOT_PR_STATUS_QUERY requests the same
  // mergeStateStatus + statusCheckRollup fields that time out at larger batch sizes.
  const batches = chunkArray(nodeIds, HEAVY_BACKFILL_BATCH_SIZE);
  let hadErrors = false;
  const ingestHotNodes = (
    nodes: readonly (HotPRStatusNode | null)[] | undefined,
    erroredIndices?: ReadonlySet<number>,
  ): void => {
    if (!Array.isArray(nodes)) return;
    for (const [idx, node] of nodes.entries()) {
      if (!node || node.databaseId == null || erroredIndices?.has(idx)) continue;

      // Fork PRs whose CI runs only in the fork report no PR-level rollup; read the
      // fork head commit's rollup instead (the same source runForkPRFallback uses).
      const rollup =
        node.statusCheckRollup ??
        (node.isCrossRepository ? (node.headRef?.target?.statusCheckRollup ?? null) : null);
      const checkStatus = applyMergeStateOverride(node.mergeStateStatus, mapCheckStatus(rollup));

      results.set(node.databaseId, {
        state: node.state,
        ...(typeof node.isDraft === "boolean" ? { draft: node.isDraft } : {}),
        ...(node.updatedAt ? { updatedAt: node.updatedAt } : {}),
        checkStatus,
        mergeStateStatus: node.mergeStateStatus,
        reviewDecision: mapReviewDecision(node.reviewDecision),
        ...(node.headRefOid ? { headSha: node.headRefOid } : {}),
        autoMergeMethod: mapAutoMergeMethod(node.autoMergeRequest?.mergeMethod),
        viewerReviewRequested: Boolean(node.viewerLatestReviewRequest?.id),
        viewerLatestReviewState: mapViewerReviewState(node.viewerLatestReview?.state),
      });
    }
  };

  const settled = await Promise.allSettled(batches.map(async (batch) => {
    const response = await octokit.graphql<HotPRStatusResponse>(HOT_PR_STATUS_QUERY, { ids: batch, request: { apiSource: "hotPRStatus" } });
    if (response.rateLimit) {
      updateGraphqlRateLimit(response.rateLimit);
    }
    ingestHotNodes(response.nodes);
  }));

  for (const s of settled) {
    if (s.status === "rejected") {
      // Token is invalid — let the caller trigger re-auth instead of retrying forever.
      if (isUnauthorizedError(s.reason)) throw s.reason;
      hadErrors = true;
      console.warn("[hot-poll] PR status batch failed:", s.reason);
      if (options?.reportToSentry) {
        Sentry.captureException(s.reason, { tags: { source: "hot-poll-pr-batch" } });
      }
      // Salvage nodes GraphQL resolved before the batch errored so stale/pending
      // PRs in a partially failing batch still get a status this cycle.
      const partialErr = extractPartialGraphqlData<HotPRStatusResponse>(s.reason);
      if (partialErr?.rateLimit) {
        updateGraphqlRateLimit(partialErr.rateLimit);
      }
      ingestHotNodes(partialErr?.nodes, extractErroredNodeIndices(s.reason));
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
async function tryGetUser(
  octokit: GitHubOctokit,
  username: string
): Promise<RawGitHubUser | null> {
  try {
    const response = await octokit.request("GET /users/{username}", { username }) as { data: RawGitHubUser };
    return response.data;
  } catch (err) {
    const status =
      typeof err === "object" && err !== null && "status" in err
        ? (err as { status: number }).status
        : null;
    if (status === 404) return null;
    throw err;
  }
}

export async function validateGitHubUser(
  octokit: GitHubOctokit,
  login: string
): Promise<TrackedUser | null> {
  const base = login.replace(/\[bot\]$/i, "");
  if (!VALID_TRACKED_LOGIN.test(base)) return null;

  let raw = await tryGetUser(octokit, base);
  if (!raw) {
    raw = await tryGetUser(octokit, `${base}[bot]`);
  }
  if (!raw) return null;

  const avatarUrl = raw.avatar_url.startsWith(AVATAR_CDN_PREFIX)
    ? raw.avatar_url
    : AVATAR_FALLBACK;

  return {
    login: raw.login.toLowerCase().replace(/\[bot\]$/, ""),
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
    const issueQ = `is:issue is:open archived:false involves:${login}`;
    const prQ = `is:pr is:open archived:false involves:${login}`;
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

// ── PR Approval Mutation ─────────────────────────────────────────────────────

interface ApprovePullRequestResponse {
  addPullRequestReview: {
    pullRequestReview: {
      state: string | null;
      pullRequest: {
        reviewDecision: string | null;
      } | null;
    } | null;
  } | null;
  rateLimit?: GraphQLRateLimit;
}

export async function approvePullRequest(
  octokit: GitHubOctokit,
  pullRequestId: string,
  commitOID: string,
): Promise<{ state: ViewerReviewState | null; reviewDecision: PullRequest["reviewDecision"] }> {
  if (!GITHUB_NODE_ID_RE.test(pullRequestId)) {
    throw new Error(`Invalid pullRequestId: "${pullRequestId}"`);
  }
  if (!GIT_SHA_RE.test(commitOID)) {
    throw new Error(`Invalid commitOID: "${commitOID}"`);
  }

  const response = await octokit.graphql<ApprovePullRequestResponse>(APPROVE_PR_MUTATION, {
    pullRequestId,
    commitOID,
    request: { apiSource: "approvePR", retries: 0 },
  });

  if (response.rateLimit) {
    updateGraphqlRateLimit(response.rateLimit);
  }

  const review = response.addPullRequestReview?.pullRequestReview;
  const state = mapViewerReviewState(review?.state);
  if (state !== "APPROVED") {
    throw new Error("GitHub did not confirm pull request approval");
  }
  return {
    state,
    reviewDecision: mapReviewDecision(review?.pullRequest?.reviewDecision ?? null),
  };
}

interface MarkPullRequestReadyResponse {
  markPullRequestReadyForReview: {
    pullRequest: {
      isDraft: boolean | null;
      reviewDecision: string | null;
    } | null;
  } | null;
  rateLimit?: GraphQLRateLimit;
}

export async function markPullRequestReady(
  octokit: GitHubOctokit,
  pullRequestId: string,
): Promise<{ draft: false; reviewDecision: PullRequest["reviewDecision"] }> {
  if (!GITHUB_NODE_ID_RE.test(pullRequestId)) {
    throw new Error(`Invalid pullRequestId: "${pullRequestId}"`);
  }

  const response = await octokit.graphql<MarkPullRequestReadyResponse>(MARK_PR_READY_MUTATION, {
    pullRequestId,
    request: { apiSource: "markPRReady", retries: 0 },
  });

  if (response.rateLimit) {
    updateGraphqlRateLimit(response.rateLimit);
  }

  const pr = response.markPullRequestReadyForReview?.pullRequest;
  if (!pr || pr.isDraft !== false) {
    throw new Error("GitHub did not confirm pull request is ready for review");
  }
  return {
    draft: false,
    reviewDecision: mapReviewDecision(pr.reviewDecision ?? null),
  };
}

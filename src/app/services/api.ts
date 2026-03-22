import { getClient, cachedRequest } from "./github";
import { evictByPrefix } from "../stores/cache";
import { pushError } from "../lib/errors";

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
  reviewComments: number;
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
}

interface RawPullRequest {
  id: number;
  number: number;
  title: string;
  state: string;
  draft: boolean;
  html_url: string;
  created_at: string;
  updated_at: string;
  user: { login: string; avatar_url: string } | null;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { ref: string };
  assignees: { login: string }[];
  requested_reviewers: { login: string }[];
  additions: number;
  deletions: number;
  changed_files: number;
  comments: number;
  review_comments: number;
  labels: { name: string; color: string }[];
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

// ── Search API types ─────────────────────────────────────────────────────────

interface RawSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: RawSearchItem[];
}

interface RawSearchItem {
  id: number;
  number: number;
  title: string;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  user: { login: string; avatar_url: string } | null;
  labels: { name: string; color: string }[];
  assignees: { login: string }[];
  repository: { full_name: string };
  pull_request?: unknown;
  comments: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

// Batch repos into chunks for search queries (keeps URL length manageable)
const SEARCH_REPO_BATCH_SIZE = 30;

// Max PRs per GraphQL batch. Each alias fetches statusCheckRollup + pullRequest
// (reviewDecision + latestReviews(first:15)). Cost: ~16 nodes/alias = ~800 pts/batch.
// At 6 polls/hr (10min interval): ~4800 pts/hr against 5000/hr GraphQL budget.
// Do not increase batch size or latestReviews.first without recalculating.
const GRAPHQL_CHECK_BATCH_SIZE = 50;

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

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Paginated search. Returns up to 1000 items per query.
 * Search API has its own rate limit: 30 req/min (separate from core 5000/hr).
 * Does NOT use IDB caching — search results are volatile and the poll interval
 * already gates how often we call.
 */
async function searchAllPages(
  octokit: NonNullable<ReturnType<typeof getClient>>,
  query: string
): Promise<RawSearchItem[]> {
  const items: RawSearchItem[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await octokit.request("GET /search/issues", {
      q: query,
      per_page: perPage,
      page,
      sort: "updated",
      order: "desc",
    });

    const data = response.data as unknown as RawSearchResponse;
    items.push(...data.items);

    if (
      items.length >= data.total_count ||
      items.length >= 1000 ||
      data.items.length < perPage
    ) {
      if (data.incomplete_results) {
        console.warn(
          `[api] Search results incomplete for: ${query.slice(0, 80)}…`
        );
        pushError("search", "Search results may be incomplete — GitHub returned partial data", false);
      }
      if (items.length >= 1000 && data.total_count > 1000) {
        console.warn(
          `[api] Search results capped at 1000 (${data.total_count} total) for: ${query.slice(0, 80)}…`
        );
        pushError("search", `Search results capped at 1,000 of ${data.total_count.toLocaleString()} total — some items are hidden`, false);
      }
      break;
    }
    page++;
  }

  return items;
}

/**
 * Runs a search query across batched repo qualifiers, deduplicating results.
 * Splits repos into chunks of SEARCH_REPO_BATCH_SIZE to keep query length safe.
 */
interface BatchSearchResult {
  items: RawSearchItem[];
  errors: ApiError[];
}

async function batchedSearch(
  octokit: NonNullable<ReturnType<typeof getClient>>,
  baseQuery: string,
  repos: RepoRef[]
): Promise<BatchSearchResult> {
  if (repos.length === 0) return { items: [], errors: [] };

  const chunks = chunkArray(repos, SEARCH_REPO_BATCH_SIZE);
  const tasks = chunks.map((chunk) => {
    const repoQualifiers = chunk.map((r) => `repo:${r.fullName}`).join(" ");
    return searchAllPages(octokit, `${baseQuery} ${repoQualifiers}`);
  });

  const results = await Promise.allSettled(tasks);
  const seen = new Set<number>();
  const items: RawSearchItem[] = [];
  const errors: ApiError[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status !== "fulfilled") {
      const { statusCode, message } = extractRejectionError(result.reason);
      errors.push({
        repo: `search-batch-${i + 1}/${chunks.length}`,
        statusCode,
        message,
        retryable: statusCode === null || statusCode >= 500,
      });
      continue;
    }
    for (const item of result.value) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }

  return { items, errors };
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
): Promise<RepoRef[]> {
  if (!octokit) throw new Error("No GitHub client available");

  const route =
    type === "org"
      ? `GET /orgs/{org}/repos`
      : `GET /user/repos`;

  const params =
    type === "org"
      ? { org: orgOrUser, per_page: 100 }
      : { affiliation: "owner", per_page: 100 };

  const repos: RepoRef[] = [];

  for await (const response of octokit.paginate.iterator(route, params)) {
    const page = response.data as RawRepo[];
    for (const repo of page) {
      repos.push({
        owner: repo.owner.login,
        name: repo.name,
        fullName: repo.full_name,
      });
    }
  }

  return repos;
}

// ── Step 3: fetchIssues (Search API) ─────────────────────────────────────────

/**
 * Fetches open issues across repos where the user is involved (author, assignee,
 * mentioned, or commenter) using the GitHub Search API.
 *
 * Before: 3 API calls per repo (creator/assignee/mentioned) = 225 calls for 75 repos.
 * After:  ~3 search calls total (batched in chunks of 30 repos).
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

  const { items, errors } = await batchedSearch(
    octokit,
    `is:issue is:open involves:${userLogin}`,
    repos
  );

  const issues = items
    .filter((item) => item.pull_request === undefined)
    .map((item) => ({
      id: item.id,
      number: item.number,
      title: item.title,
      state: item.state,
      htmlUrl: item.html_url,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      userLogin: item.user?.login ?? "",
      userAvatarUrl: item.user?.avatar_url ?? "",
      labels: item.labels.map((l) => ({ name: l.name, color: l.color })),
      assigneeLogins: item.assignees.map((a) => a.login),
      repoFullName: item.repository.full_name,
      comments: item.comments,
    }));

  return { issues, errors };
}

// ── Step 4: fetchPullRequests (Search API + GraphQL check status) ─────────────

interface CheckStatusResult {
  checkStatus: CheckStatus["status"];
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  actualReviewerLogins: string[];
  totalReviewCount: number;
}

type GitHubOctokit = NonNullable<ReturnType<typeof getClient>>;

/**
 * REST fallback for check status + reviews when GraphQL is unavailable.
 * Uses the core REST rate limit (5000/hr, separate from GraphQL 5000 pts/hr).
 * All requests go through cachedRequest for ETag-based caching.
 *
 * Fetches both the legacy Status API and the Check Runs API in parallel, then
 * combines their results so GitHub Actions workflows (which use Check Runs) are
 * correctly reflected. This makes REST a full-fidelity fallback for GraphQL.
 */
async function restFallbackCheckStatuses(
  octokit: GitHubOctokit,
  prs: { owner: string; repo: string; sha: string; prNumber: number }[],
  results: Map<string, CheckStatusResult>
): Promise<void> {
  // Process in chunks of 10 to avoid overwhelming the browser's 6-connection limit
  const REST_CONCURRENCY = 10;
  const chunks = chunkArray(prs, REST_CONCURRENCY);
  for (const chunk of chunks) {
    const tasks = chunk.map(async (pr) => {
      const key = `${pr.owner}/${pr.repo}:${pr.sha}`;
      try {
        // Fetch legacy Status API, Check Runs API, and PR reviews in parallel
        const [statusResult, checkRunsResult, reviewsResult] = await Promise.all([
          cachedRequest(
            octokit,
            `rest-status:${key}`,
            "GET /repos/{owner}/{repo}/commits/{ref}/status",
            { owner: pr.owner, repo: pr.repo, ref: pr.sha }
          ),
          cachedRequest(
            octokit,
            `rest-check-runs:${key}`,
            "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
            { owner: pr.owner, repo: pr.repo, ref: pr.sha }
          ),
          cachedRequest(
            octokit,
            `rest-reviews:${pr.owner}/${pr.repo}:${pr.prNumber}`,
            "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
            { owner: pr.owner, repo: pr.repo, pull_number: pr.prNumber }
          ),
        ]);

        const statusData = statusResult.data as { state: string; total_count: number };
        const checkRunsData = checkRunsResult.data as {
          check_runs: { status: string; conclusion: string | null }[];
        };
        const reviews = reviewsResult.data as { user: { login: string } | null; state: string }[];

        // Derive combined check status from both endpoints.
        // Status API returns state:"pending" with total_count:0 when no statuses exist.
        // Check Runs API returns an empty array when no check runs exist.
        // If BOTH are empty → no CI configured → null.
        const noLegacyStatuses = statusData.total_count === 0;
        const noCheckRuns = checkRunsData.check_runs.length === 0;

        let checkStatus: CheckStatus["status"];
        if (noLegacyStatuses && noCheckRuns) {
          checkStatus = null;
        } else {
          const legacyFailed =
            statusData.state === "failure" || statusData.state === "error";
          const checkRunFailed = checkRunsData.check_runs.some(
            (cr) => cr.conclusion === "failure" || cr.conclusion === "timed_out" || cr.conclusion === "cancelled"
          );

          if (legacyFailed || checkRunFailed) {
            checkStatus = "failure";
          } else {
            const legacySuccess = statusData.state === "success" || noLegacyStatuses;
            const allCheckRunsComplete = noCheckRuns ||
              checkRunsData.check_runs.every((cr) => cr.status === "completed");
            const allCheckRunsSuccess = checkRunsData.check_runs.every(
              (cr) => cr.conclusion === "success" || cr.conclusion === "skipped" || cr.conclusion === "neutral"
            );

            if (legacySuccess && allCheckRunsComplete && allCheckRunsSuccess) {
              checkStatus = "success";
            } else {
              checkStatus = "pending";
            }
          }
        }

        // Derive review decision from latest review per author.
        // Include COMMENTED to make REVIEW_REQUIRED reachable (comments without approval).
        const latestByAuthor = new Map<string, string>();
        for (const review of reviews) {
          if (review.user?.login && (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED" || review.state === "COMMENTED")) {
            latestByAuthor.set(review.user.login.toLowerCase(), review.state);
          }
        }
        let reviewDecision: CheckStatusResult["reviewDecision"] = null;
        if (latestByAuthor.size > 0) {
          const states = [...latestByAuthor.values()];
          if (states.some((s) => s === "CHANGES_REQUESTED")) reviewDecision = "CHANGES_REQUESTED";
          else if (states.every((s) => s === "APPROVED")) reviewDecision = "APPROVED";
          else reviewDecision = "REVIEW_REQUIRED";
        }

        const actualReviewerLogins = reviews
          .filter((r) => r.user?.login)
          .map((r) => r.user!.login);
        // Deduplicate reviewer logins
        const uniqueReviewers = [...new Set(actualReviewerLogins)];

        results.set(key, { checkStatus, reviewDecision, actualReviewerLogins: uniqueReviewers, totalReviewCount: reviews.length });
      } catch (err) {
        console.warn(`[api] REST fallback failed for ${key}:`, err);
        results.set(key, { checkStatus: null, reviewDecision: null, actualReviewerLogins: [], totalReviewCount: 0 });
      }
    });

    await Promise.allSettled(tasks);
  }
}

/**
 * Batches check status lookups into a single GraphQL call using
 * `statusCheckRollup.state`, which combines both legacy commit status API
 * and modern check runs into one field.
 *
 * Replaces 2N REST calls (commit status + check runs) with 1 GraphQL call.
 * Uses parameterized variables to prevent injection.
 */
async function batchFetchCheckStatuses(
  octokit: NonNullable<ReturnType<typeof getClient>>,
  prs: { owner: string; repo: string; sha: string; prNumber: number }[]
): Promise<Map<string, CheckStatusResult>> {
  if (prs.length === 0) return new Map();

  const results = new Map<string, CheckStatusResult>();
  const failedKeys = new Set<string>();
  const failedPrs: typeof prs = [];

  // Batch into chunks and run in parallel
  const chunks = chunkArray(prs, GRAPHQL_CHECK_BATCH_SIZE);

  const chunkTasks = chunks.map(async (chunk) => {
    const varDefs: string[] = [];
    const variables: Record<string, string | number> = {};
    const fragments: string[] = [];

    for (let i = 0; i < chunk.length; i++) {
      varDefs.push(
        `$owner${i}: String!`,
        `$repo${i}: String!`,
        `$sha${i}: String!`,
        `$prNum${i}: Int!`
      );
      variables[`owner${i}`] = chunk[i].owner;
      variables[`repo${i}`] = chunk[i].repo;
      variables[`sha${i}`] = chunk[i].sha;
      variables[`prNum${i}`] = chunk[i].prNumber;
      fragments.push(
        `pr${i}: repository(owner: $owner${i}, name: $repo${i}) {
          object(expression: $sha${i}) {
            ... on Commit {
              statusCheckRollup {
                state
              }
            }
          }
          pullRequest(number: $prNum${i}) {
            reviewDecision
            latestReviews(first: 15) {
              totalCount
              nodes {
                author {
                  login
                }
              }
            }
          }
        }`
      );
    }

    const query = `query(${varDefs.join(", ")}) {\n${fragments.join("\n")}\nrateLimit { remaining resetAt }\n}`;

    try {
      interface GraphQLRepoResult {
        object: {
          statusCheckRollup: { state: string } | null;
        } | null;
        pullRequest: {
          reviewDecision: string | null;
          latestReviews: {
            totalCount: number;
            nodes: { author: { login: string } | null }[];
          };
        } | null;
      }
      interface GraphQLRateLimit {
        remaining: number;
        resetAt: string;
      }

      const response = (await octokit.graphql(query, variables)) as
        Record<string, GraphQLRepoResult | null> & { rateLimit?: GraphQLRateLimit };

      // Log GraphQL rate limit for debugging but don't overwrite the REST
      // rate limit signal — they're separate pools and REST is the bottleneck
      if (response.rateLimit) {
        console.debug("[api] GraphQL rate limit remaining:", response.rateLimit.remaining);
      }

      for (let i = 0; i < chunk.length; i++) {
        const data = response[`pr${i}`] as GraphQLRepoResult | null;
        const state = data?.object?.statusCheckRollup?.state ?? null;
        const key = `${chunk[i].owner}/${chunk[i].repo}:${chunk[i].sha}`;

        let checkStatus: CheckStatus["status"];
        if (state === "FAILURE" || state === "ERROR") {
          checkStatus = "failure";
        } else if (state === "PENDING" || state === "EXPECTED") {
          checkStatus = "pending";
        } else if (state === "SUCCESS") {
          checkStatus = "success";
        } else {
          checkStatus = null;
        }

        const rawReviewDecision = data?.pullRequest?.reviewDecision ?? null;
        const reviewDecision =
          rawReviewDecision === "APPROVED" ||
          rawReviewDecision === "CHANGES_REQUESTED" ||
          rawReviewDecision === "REVIEW_REQUIRED"
            ? rawReviewDecision
            : null;

        const actualReviewerLogins = (data?.pullRequest?.latestReviews?.nodes ?? [])
          .filter((n) => n.author?.login)
          .map((n) => n.author!.login);
        const totalReviewCount = data?.pullRequest?.latestReviews?.totalCount ?? 0;

        results.set(key, { checkStatus, reviewDecision, actualReviewerLogins, totalReviewCount });
      }
    } catch (err) {
      console.warn("[api] GraphQL check status batch failed:", err);
      // Track failed PRs for cache lookup / REST fallback
      for (const pr of chunk) {
        const key = `${pr.owner}/${pr.repo}:${pr.sha}`;
        failedKeys.add(key);
        failedPrs.push(pr);
      }
    }
  });

  await Promise.allSettled(chunkTasks);

  // Tier 2: REST fallback for ALL failed PRs (not just cache misses).
  // REST uses the core rate limit (5000/hr, separate from GraphQL 5000 pts/hr).
  // ETag caching via cachedRequest means unchanged PRs return 304 (free).
  if (failedPrs.length > 0) {
    pushError("graphql", `Fetching check/review data via REST for ${failedPrs.length} PR(s) — GraphQL rate limited`, true);
    await restFallbackCheckStatuses(octokit, failedPrs, results);
  }

  return results;
}

/**
 * Fetches open PRs involving the user using the GitHub Search API.
 * Two search queries cover all involvement types:
 * - `involves:user` → author, assignee, mentioned, commenter
 * - `review-requested:user` → requested reviewer (not covered by `involves`)
 *
 * For each found PR, fetches full PR details (head SHA, reviewers) via REST,
 * then batches ALL check statuses into a single GraphQL call.
 *
 * Before: 1 API call per repo (list all PRs) + 2 per involved PR = 75+2N for 75 repos.
 * After:  ~6 search + N PR detail + 1 GraphQL = 7+N.
 */
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

  const allErrors: ApiError[] = [];

  // Two searches: involves (author/assignee/mentioned/commenter) + review-requested
  const [involvedResult, reviewResult] = await Promise.allSettled([
    batchedSearch(octokit, `is:pr is:open involves:${userLogin}`, repos),
    batchedSearch(
      octokit,
      `is:pr is:open review-requested:${userLogin}`,
      repos
    ),
  ]);

  // Merge and deduplicate by ID, collect search errors
  const seen = new Set<number>();
  const uniqueItems: RawSearchItem[] = [];

  for (const result of [involvedResult, reviewResult]) {
    if (result.status !== "fulfilled") continue;
    allErrors.push(...result.value.errors);
    for (const item of result.value.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      uniqueItems.push(item);
    }
  }

  // Fetch full PR details for each (head SHA, branch info, reviewers)
  const prDetailTasks = uniqueItems
    .filter((item) => item.repository.full_name.includes("/"))
    .map(async (item) => {
      const repoFullName = item.repository.full_name;
      const [owner, name] = repoFullName.split("/");

      const result = await cachedRequest(
        octokit,
        `pr-detail:${repoFullName}:${item.number}`,
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        { owner, repo: name, pull_number: item.number }
      );

      return { pr: result.data as RawPullRequest, repoFullName };
    });

  const prDetails = await Promise.allSettled(prDetailTasks);

  for (const result of prDetails) {
    if (result.status === "rejected") {
      const { statusCode, message } = extractRejectionError(result.reason);
      allErrors.push({ repo: "pr-detail", statusCode, message, retryable: true });
    }
  }

  const successfulPRs = prDetails
    .filter(
      (r): r is PromiseFulfilledResult<{
        pr: RawPullRequest;
        repoFullName: string;
      }> => r.status === "fulfilled"
    )
    .map((r) => r.value);

  // Batch ALL check statuses into a single GraphQL call
  const checkInputs = successfulPRs.map(({ pr, repoFullName }) => {
    const [owner, repo] = repoFullName.split("/");
    return { owner, repo, sha: pr.head.sha, prNumber: pr.number };
  });

  const checkStatuses = await batchFetchCheckStatuses(octokit, checkInputs);

  // Build final PR objects
  const pullRequests = successfulPRs.map(({ pr, repoFullName }) => {
    const result = checkStatuses.get(`${repoFullName}:${pr.head.sha}`);
    const requestedReviewerLogins = pr.requested_reviewers.map((r) => r.login);
    const actualReviewerLogins = result?.actualReviewerLogins ?? [];
    const reviewerLogins = [...new Set([...requestedReviewerLogins, ...actualReviewerLogins])];
    return {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      draft: pr.draft,
      htmlUrl: pr.html_url,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      userLogin: pr.user?.login ?? "",
      userAvatarUrl: pr.user?.avatar_url ?? "",
      headSha: pr.head.sha,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      assigneeLogins: pr.assignees.map((a) => a.login),
      reviewerLogins,
      repoFullName,
      checkStatus: result?.checkStatus ?? null,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      comments: pr.comments,
      reviewComments: pr.review_comments,
      labels: pr.labels.map((l) => ({ name: l.name, color: l.color })),
      reviewDecision: result?.reviewDecision ?? null,
      totalReviewCount: result?.totalReviewCount ?? 0,
    };
  });

  // Evict stale PR detail cache entries for PRs no longer in the active set
  const activeKeys = new Set(
    uniqueItems.map((item) => `pr-detail:${item.repository.full_name}:${item.number}`)
  );
  evictByPrefix("pr-detail:", activeKeys).catch(() => {
    // Non-fatal — eviction failure shouldn't block the result
  });

  return { pullRequests, errors: allErrors };
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
  // Paginate if the first page isn't enough.
  const targetRunsPerRepo = maxWorkflows * maxRuns;

  const repoTasks = repos.map(async (repo) => {
    const rawRuns: RawWorkflowRun[] = [];
    let page = 1;

    // Paginate until we have enough runs or exhaust results
    while (rawRuns.length < targetRunsPerRepo) {
      const result = await cachedRequest(
        octokit,
        `runs:${repo.fullName}:p${page}`,
        "GET /repos/{owner}/{repo}/actions/runs",
        { owner: repo.owner, repo: repo.name, per_page: 100, page }
      );

      const data = result.data as {
        workflow_runs: RawWorkflowRun[];
        total_count: number;
      };
      const runs = data.workflow_runs ?? [];
      rawRuns.push(...runs);

      // Stop if we got all runs or this page was short
      if (rawRuns.length >= data.total_count || runs.length < 100) break;
      page++;
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
    workflowEntries.sort((a, b) => b.latestAt < a.latestAt ? -1 : b.latestAt > a.latestAt ? 1 : 0);
    const topWorkflows = workflowEntries
      .slice(0, maxWorkflows);

    // Take most recent M runs per workflow
    for (const { runs: workflowRuns } of topWorkflows) {
      const sorted = workflowRuns.sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
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

  const repoResults = await Promise.allSettled(repoTasks);
  for (const result of repoResults) {
    if (result.status === "rejected") {
      const { statusCode, message } = extractRejectionError(result.reason);
      allErrors.push({ repo: "workflow-runs", statusCode, message, retryable: true });
    }
  }

  return { workflowRuns: allRuns, errors: allErrors };
}

// ── Step 6: aggregateErrors ──────────────────────────────────────────────────

/**
 * Input: zipped array of [PromiseSettledResult, repoFullName] pairs.
 * Returns structured errors for each rejected result.
 */
export function aggregateErrors(
  results: [PromiseSettledResult<unknown>, string][]
): ApiError[] {
  const errors: ApiError[] = [];

  for (const [result, repo] of results) {
    if (result.status !== "rejected") continue;

    const reason: unknown = result.reason;
    const statusCode =
      typeof reason === "object" &&
      reason !== null &&
      typeof (reason as Record<string, unknown>)["status"] === "number"
        ? ((reason as Record<string, unknown>)["status"] as number)
        : null;

    const message =
      typeof reason === "object" &&
      reason !== null &&
      typeof (reason as Record<string, unknown>)["message"] === "string"
        ? ((reason as Record<string, unknown>)["message"] as string)
        : "Unknown error";

    let retryable = false;

    if (statusCode === 401) {
      // Auth error — not retryable without re-auth
      retryable = false;
    } else if (statusCode === 403) {
      // Forbidden or rate limit
      const isRateLimit =
        typeof reason === "object" &&
        reason !== null &&
        typeof (reason as Record<string, unknown>)["headers"] === "object" &&
        (
          (reason as Record<string, unknown>)["headers"] as Record<
            string,
            unknown
          >
        )["x-ratelimit-remaining"] === "0";
      retryable = isRateLimit;
    } else if (statusCode === 404) {
      retryable = false;
    } else if (statusCode !== null && statusCode >= 500) {
      retryable = true;
    } else if (statusCode === null) {
      // Network error
      retryable = true;
    }

    errors.push({ repo, statusCode, message, retryable });
  }

  return errors;
}

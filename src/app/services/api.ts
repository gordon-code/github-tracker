import { getClient, cachedRequest, updateRateLimitFromGraphQL } from "./github";
import { evictByPrefix } from "../stores/cache";

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
}

// ── Constants ────────────────────────────────────────────────────────────────

// Batch repos into chunks for search queries (keeps URL length manageable)
const SEARCH_REPO_BATCH_SIZE = 30;

// Max PRs per GraphQL batch (keeps query complexity low)
const GRAPHQL_CHECK_BATCH_SIZE = 50;

// ── Search helpers ───────────────────────────────────────────────────────────

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
      }
      if (items.length >= 1000 && data.total_count > 1000) {
        console.warn(
          `[api] Search results capped at 1000 (${data.total_count} total) for: ${query.slice(0, 80)}…`
        );
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
      const reason = result.reason as { status?: number; message?: string } | Error;
      const statusCode = typeof reason === "object" && "status" in reason
        ? (reason.status as number) ?? null : null;
      const message = reason instanceof Error ? reason.message : String(reason);
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
  userLogin: string,
  updatedSince?: Date
): Promise<FetchIssuesResult> {
  if (!octokit) throw new Error("No GitHub client available");
  if (repos.length === 0 || !userLogin) return { issues: [], errors: [] };

  let query = `is:issue is:open involves:${userLogin}`;
  if (updatedSince) {
    query += ` updated:>=${updatedSince.toISOString()}`;
  }

  const { items, errors } = await batchedSearch(
    octokit,
    query,
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
    }));

  return { issues, errors };
}

// ── Step 4: fetchPullRequests (Search API + GraphQL check status) ─────────────

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
  prs: { owner: string; repo: string; sha: string }[]
): Promise<Map<string, CheckStatus["status"]>> {
  if (prs.length === 0) return new Map();

  const results = new Map<string, CheckStatus["status"]>();

  // Batch into chunks and run in parallel
  const chunks = chunkArray(prs, GRAPHQL_CHECK_BATCH_SIZE);

  const chunkTasks = chunks.map(async (chunk) => {
    const varDefs: string[] = [];
    const variables: Record<string, string> = {};
    const fragments: string[] = [];

    for (let i = 0; i < chunk.length; i++) {
      varDefs.push(
        `$owner${i}: String!`,
        `$repo${i}: String!`,
        `$sha${i}: String!`
      );
      variables[`owner${i}`] = chunk[i].owner;
      variables[`repo${i}`] = chunk[i].repo;
      variables[`sha${i}`] = chunk[i].sha;
      fragments.push(
        `pr${i}: repository(owner: $owner${i}, name: $repo${i}) {
          object(expression: $sha${i}) {
            ... on Commit {
              statusCheckRollup {
                state
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
      }
      interface GraphQLRateLimit {
        remaining: number;
        resetAt: string;
      }

      const response = (await octokit.graphql(query, variables)) as
        Record<string, GraphQLRepoResult | null> & { rateLimit?: GraphQLRateLimit };

      if (response.rateLimit) {
        updateRateLimitFromGraphQL(response.rateLimit);
      }

      for (let i = 0; i < chunk.length; i++) {
        const data = response[`pr${i}`] as GraphQLRepoResult | null;
        const state = data?.object?.statusCheckRollup?.state ?? null;
        const key = `${chunk[i].owner}/${chunk[i].repo}:${chunk[i].sha}`;

        if (state === "FAILURE" || state === "ERROR") {
          results.set(key, "failure");
        } else if (state === "PENDING" || state === "EXPECTED") {
          results.set(key, "pending");
        } else if (state === "SUCCESS") {
          results.set(key, "success");
        } else {
          results.set(key, null);
        }
      }
    } catch (err) {
      console.warn("[api] GraphQL check status batch failed:", err);
      for (const pr of chunk) {
        results.set(`${pr.owner}/${pr.repo}:${pr.sha}`, null);
      }
    }
  });

  await Promise.allSettled(chunkTasks);

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
  userLogin: string,
  updatedSince?: Date
): Promise<FetchPullRequestsResult> {
  if (!octokit) throw new Error("No GitHub client available");
  if (repos.length === 0 || !userLogin) return { pullRequests: [], errors: [] };

  const allErrors: ApiError[] = [];

  let involvedQuery = `is:pr is:open involves:${userLogin}`;
  let reviewQuery = `is:pr is:open review-requested:${userLogin}`;
  if (updatedSince) {
    const ts = ` updated:>=${updatedSince.toISOString()}`;
    involvedQuery += ts;
    reviewQuery += ts;
  }

  // Two searches: involves (author/assignee/mentioned/commenter) + review-requested
  const [involvedResult, reviewResult] = await Promise.allSettled([
    batchedSearch(octokit, involvedQuery, repos),
    batchedSearch(octokit, reviewQuery, repos),
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
      const reason = result.reason as { status?: number; message?: string } | Error;
      allErrors.push({
        repo: "pr-detail",
        statusCode: typeof reason === "object" && "status" in reason
          ? (reason.status as number) ?? null : null,
        message: reason instanceof Error ? reason.message : String(reason),
        retryable: true,
      });
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
    return { owner, repo, sha: pr.head.sha };
  });

  const checkStatuses = await batchFetchCheckStatuses(octokit, checkInputs);

  // Build final PR objects
  const pullRequests = successfulPRs.map(({ pr, repoFullName }) => ({
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
    reviewerLogins: pr.requested_reviewers.map((r) => r.login),
    repoFullName,
    checkStatus: checkStatuses.get(`${repoFullName}:${pr.head.sha}`) ?? null,
  }));

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
  maxRuns: number,
  createdSince?: Date
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
      const params: Record<string, unknown> = {
        owner: repo.owner,
        repo: repo.name,
        per_page: 100,
        page,
      };
      // Server-side date filter reduces payload on subsequent polls
      if (createdSince) {
        params.created = `>=${createdSince.toISOString()}`;
      }

      const result = await cachedRequest(
        octokit,
        `runs:${repo.fullName}:p${page}`,
        "GET /repos/{owner}/{repo}/actions/runs",
        params
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
    const topWorkflows = [...byWorkflow.entries()]
      .sort(([, a], [, b]) => {
        const latestA = Math.max(...a.map((r) => new Date(r.updated_at).getTime()));
        const latestB = Math.max(...b.map((r) => new Date(r.updated_at).getTime()));
        return latestB - latestA;
      })
      .slice(0, maxWorkflows);

    // Take most recent M runs per workflow
    for (const [, workflowRuns] of topWorkflows) {
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
        });
      }
    }
  });

  const repoResults = await Promise.allSettled(repoTasks);
  for (const result of repoResults) {
    if (result.status === "rejected") {
      const reason = result.reason as { status?: number; message?: string } | Error;
      allErrors.push({
        repo: "workflow-runs",
        statusCode: typeof reason === "object" && "status" in reason
          ? (reason.status as number) ?? null : null,
        message: reason instanceof Error ? reason.message : String(reason),
        retryable: true,
      });
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

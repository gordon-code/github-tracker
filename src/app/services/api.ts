import { getClient, cachedRequest } from "./github";

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

interface RawIssue {
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
  repository_url: string;
  pull_request?: unknown;
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

interface RawCommitStatus {
  state: string;
  statuses: { state: string }[];
  total_count: number;
}

interface RawCheckRun {
  status: string;
  conclusion: string | null;
}

interface RawCheckRuns {
  total_count: number;
  check_runs: RawCheckRun[];
}

interface RawWorkflow {
  id: number;
  name: string;
  updated_at: string;
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

// ── Step 3: fetchIssues ──────────────────────────────────────────────────────

type IssueInvolvement = "creator" | "assignee" | "mentioned";

async function fetchIssuesForRepo(
  octokit: NonNullable<ReturnType<typeof getClient>>,
  repo: RepoRef,
  involvement: IssueInvolvement,
  userLogin: string
): Promise<RawIssue[]> {
  const [owner, name] = [repo.owner, repo.name];
  const cacheKey = `issues:${involvement}:${owner}/${name}`;

  let qualifier: Record<string, string>;
  if (involvement === "creator") {
    qualifier = { creator: userLogin };
  } else if (involvement === "assignee") {
    qualifier = { assignee: userLogin };
  } else {
    qualifier = { mentioned: userLogin };
  }

  const result = await cachedRequest(
    octokit,
    cacheKey,
    "GET /repos/{owner}/{repo}/issues",
    { owner, repo: name, state: "open", per_page: 100, ...qualifier }
  );

  return result.data as RawIssue[];
}

/**
 * Fetches open issues across repos where the user is creator, assignee, or mentioned.
 * Deduplicates by issue ID and filters out PRs.
 */
export async function fetchIssues(
  octokit: ReturnType<typeof getClient>,
  repos: RepoRef[],
  userLogin: string
): Promise<Issue[]> {
  if (!octokit) throw new Error("No GitHub client available");

  const involvements: IssueInvolvement[] = ["creator", "assignee", "mentioned"];

  const tasks = repos.flatMap((repo) =>
    involvements.map((inv) => fetchIssuesForRepo(octokit, repo, inv, userLogin))
  );

  const results = await Promise.allSettled(tasks);

  const seen = new Set<number>();
  const issues: Issue[] = [];

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const raw of result.value) {
      // Filter out PRs
      if (raw.pull_request !== undefined) continue;
      if (seen.has(raw.id)) continue;
      seen.add(raw.id);

      // Derive repo full name from repository_url
      const repoFullName = raw.repository_url.replace(
        "https://api.github.com/repos/",
        ""
      );

      issues.push({
        id: raw.id,
        number: raw.number,
        title: raw.title,
        state: raw.state,
        htmlUrl: raw.html_url,
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
        userLogin: raw.user?.login ?? "",
        userAvatarUrl: raw.user?.avatar_url ?? "",
        labels: raw.labels.map((l) => ({ name: l.name, color: l.color })),
        assigneeLogins: raw.assignees.map((a) => a.login),
        repoFullName,
      });
    }
  }

  return issues;
}

// ── Step 4: fetchPullRequests ────────────────────────────────────────────────

// Cache check-status per SHA for 2 minutes — completed checks rarely change
const CHECK_STATUS_MAX_AGE_MS = 2 * 60 * 1000;

async function fetchCheckStatus(
  octokit: NonNullable<ReturnType<typeof getClient>>,
  owner: string,
  repo: string,
  sha: string
): Promise<CheckStatus["status"]> {
  const cacheKey = `check-status:${owner}/${repo}:${sha}`;

  const [statusResult, checkRunsResult] = await Promise.allSettled([
    cachedRequest(
      octokit,
      `${cacheKey}:status`,
      "GET /repos/{owner}/{repo}/commits/{ref}/status",
      { owner, repo, ref: sha },
      CHECK_STATUS_MAX_AGE_MS
    ),
    cachedRequest(
      octokit,
      `${cacheKey}:check-runs`,
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
      { owner, repo, ref: sha, per_page: 100 },
      CHECK_STATUS_MAX_AGE_MS
    ),
  ]);

  let hasFailure = false;
  let hasPending = false;
  let hasSuccess = false;

  // Legacy commit status
  if (statusResult.status === "fulfilled") {
    const status = statusResult.value.data as RawCommitStatus;
    if (status.total_count > 0) {
      if (status.state === "failure" || status.state === "error") {
        hasFailure = true;
      } else if (status.state === "pending") {
        hasPending = true;
      } else if (status.state === "success") {
        hasSuccess = true;
      }
    }
  }

  // Modern GHA check runs
  if (checkRunsResult.status === "fulfilled") {
    const checks = checkRunsResult.value.data as RawCheckRuns;
    for (const run of checks.check_runs) {
      if (run.status !== "completed") {
        hasPending = true;
      } else if (
        run.conclusion === "failure" ||
        run.conclusion === "timed_out" ||
        run.conclusion === "cancelled" ||
        run.conclusion === "action_required"
      ) {
        hasFailure = true;
      } else if (run.conclusion === "success") {
        hasSuccess = true;
      }
    }
  }

  if (hasFailure) return "failure";
  if (hasPending) return "pending";
  if (hasSuccess) return "success";
  return null;
}

/**
 * Fetches open PRs for each repo and filters to user-involved ones.
 * Attaches combined check status from legacy status API + GHA check-runs.
 */
export async function fetchPullRequests(
  octokit: ReturnType<typeof getClient>,
  repos: RepoRef[],
  userLogin: string
): Promise<PullRequest[]> {
  if (!octokit) throw new Error("No GitHub client available");

  const prTasks = repos.map(async (repo) => {
    const result = await cachedRequest(
      octokit,
      `prs:${repo.fullName}`,
      "GET /repos/{owner}/{repo}/pulls",
      { owner: repo.owner, repo: repo.name, state: "open", per_page: 100 }
    );
    return { repo, prs: result.data as RawPullRequest[] };
  });

  const prResults = await Promise.allSettled(prTasks);

  const involvedPrs: { repo: RepoRef; pr: RawPullRequest }[] = [];

  for (const result of prResults) {
    if (result.status !== "fulfilled") continue;
    const { repo, prs } = result.value;
    for (const pr of prs) {
      const isInvolved =
        pr.user?.login === userLogin ||
        pr.assignees.some((a) => a.login === userLogin) ||
        pr.requested_reviewers.some((r) => r.login === userLogin);
      if (isInvolved) {
        involvedPrs.push({ repo, pr });
      }
    }
  }

  const pullRequests = await Promise.all(
    involvedPrs.map(async ({ repo, pr }) => {
      const checkStatus = await fetchCheckStatus(
        octokit,
        repo.owner,
        repo.name,
        pr.head.sha
      ).catch(() => null as CheckStatus["status"]);

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
        reviewerLogins: pr.requested_reviewers.map((r) => r.login),
        repoFullName: pr.head.repo?.full_name ?? repo.fullName,
        checkStatus,
      } satisfies PullRequest;
    })
  );

  return pullRequests;
}

// ── Step 5: fetchWorkflowRuns ────────────────────────────────────────────────

const WORKFLOW_LIST_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Fetches top N workflows (by most recent run) and their latest M runs per repo.
 */
export async function fetchWorkflowRuns(
  octokit: ReturnType<typeof getClient>,
  repos: RepoRef[],
  maxWorkflows: number,
  maxRuns: number
): Promise<WorkflowRun[]> {
  if (!octokit) throw new Error("No GitHub client available");

  const allRuns: WorkflowRun[] = [];

  const repoTasks = repos.map(async (repo) => {
    // Fetch workflow list with 30-min TTL
    const workflowsResult = await cachedRequest(
      octokit,
      `workflows:${repo.fullName}`,
      "GET /repos/{owner}/{repo}/actions/workflows",
      { owner: repo.owner, repo: repo.name, per_page: 100 },
      WORKFLOW_LIST_MAX_AGE_MS
    );

    const workflowsData = workflowsResult.data as {
      workflows: RawWorkflow[];
      total_count: number;
    };
    const workflows = workflowsData.workflows ?? [];

    // Sort by most-recently-updated, take top N
    const topWorkflows = [...workflows]
      .sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      )
      .slice(0, maxWorkflows);

    // Fetch runs for each workflow
    const runTasks = topWorkflows.map(async (wf) => {
      const runsResult = await cachedRequest(
        octokit,
        `runs:${repo.fullName}:${wf.id}`,
        "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
        {
          owner: repo.owner,
          repo: repo.name,
          workflow_id: wf.id,
          per_page: maxRuns,
        }
      );

      const runsData = runsResult.data as {
        workflow_runs: RawWorkflowRun[];
      };
      const runs = runsData.workflow_runs ?? [];

      return runs.slice(0, maxRuns).map(
        (run): WorkflowRun => ({
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
        })
      );
    });

    const runResults = await Promise.allSettled(runTasks);
    for (const r of runResults) {
      if (r.status === "fulfilled") {
        allRuns.push(...r.value);
      }
    }
  });

  await Promise.allSettled(repoTasks);

  return allRuns;
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

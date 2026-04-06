import { render } from "@solidjs/testing-library";
import { MemoryRouter, createMemoryHistory } from "@solidjs/router";
import { resetViewState } from "../../src/app/stores/view";
import type { TrackedItem } from "../../src/app/stores/view";
import type { Issue, PullRequest, WorkflowRun, ApiError } from "../../src/app/services/api";
import type { JSX } from "solid-js";

let nextId = 1;

export function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: nextId++,
    number: 1,
    title: "Test issue",
    state: "open",
    htmlUrl: "https://github.com/owner/repo/issues/1",
    createdAt: "2024-01-10T08:00:00Z",
    updatedAt: "2024-01-12T14:30:00Z",
    userLogin: "octocat",
    userAvatarUrl: "https://github.com/images/error/octocat_happy.gif",
    labels: [],
    assigneeLogins: [],
    repoFullName: "owner/repo",
    comments: 0,
    ...overrides,
  };
}

export function makePullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: nextId++,
    number: 1,
    title: "Test pull request",
    state: "open",
    draft: false,
    htmlUrl: "https://github.com/owner/repo/pull/1",
    createdAt: "2024-01-10T08:00:00Z",
    updatedAt: "2024-01-12T14:30:00Z",
    userLogin: "octocat",
    userAvatarUrl: "https://github.com/images/error/octocat_happy.gif",
    headSha: "abc123def456",
    headRef: "feature/test-branch",
    baseRef: "main",
    assigneeLogins: [],
    reviewerLogins: [],
    repoFullName: "owner/repo",
    checkStatus: null,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    comments: 0,
    reviewThreads: 0,
    labels: [],
    reviewDecision: null,
    totalReviewCount: 0,
    enriched: true,
    ...overrides,
  };
}

export function makeWorkflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: nextId++,
    name: "CI",
    status: "completed",
    conclusion: "success",
    event: "push",
    workflowId: 1,
    headSha: "abc123def456",
    headBranch: "main",
    runNumber: 1,
    htmlUrl: "https://github.com/owner/repo/actions/runs/1",
    createdAt: "2024-01-10T08:00:00Z",
    updatedAt: "2024-01-12T14:30:00Z",
    repoFullName: "owner/repo",
    isPrRun: false,
    runStartedAt: "2024-01-10T08:00:00Z",
    completedAt: "2024-01-10T08:05:00Z",
    runAttempt: 1,
    displayTitle: "Workflow 1",
    actorLogin: "user",
    ...overrides,
  };
}

export function makeTrackedItem(overrides: Partial<TrackedItem> = {}): TrackedItem {
  return {
    id: nextId++,
    type: "issue",
    repoFullName: "owner/repo",
    title: "Test tracked item",
    addedAt: Date.now(),
    ...overrides,
  };
}

export function makeApiError(overrides: Partial<ApiError> = {}): ApiError {
  return {
    repo: "owner/repo",
    statusCode: 500,
    message: "Internal server error",
    retryable: true,
    ...overrides,
  };
}

export function renderWithRouter(
  component: () => JSX.Element,
  initialPath = "/"
): ReturnType<typeof render> {
  const history = createMemoryHistory();
  history.set({ value: initialPath });
  return render(() => (
    <MemoryRouter history={history}>{component()}</MemoryRouter>
  ));
}

export function resetViewStore(): void {
  resetViewState();
}

import { render } from "@solidjs/testing-library";
import { MemoryRouter, createMemoryHistory } from "@solidjs/router";
import { updateViewState } from "../../src/app/stores/view";
import type { Issue, PullRequest, WorkflowRun, ApiError } from "../../src/app/services/api";
import type { JSX } from "solid-js";

export function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: Math.floor(Math.random() * 100000),
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
    ...overrides,
  };
}

export function makePullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: Math.floor(Math.random() * 100000),
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
    ...overrides,
  };
}

export function makeWorkflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: Math.floor(Math.random() * 100000),
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
  updateViewState({
    lastActiveTab: "issues",
    sortPreferences: {},
    ignoredItems: [],
    globalFilter: { org: null, repo: null },
  });
}

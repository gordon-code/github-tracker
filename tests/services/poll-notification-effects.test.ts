/**
 * Tests for the module-scope reactive effects in poll.ts that reset notification
 * state when config.trackedUsers or config.monitoredRepos change.
 *
 * Uses the REAL reactive config store (not a static mock) so that updateConfig()
 * triggers the reactive effects registered by poll.ts at module load.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockResetNotifState } = vi.hoisted(() => ({
  mockResetNotifState: vi.fn(),
}));

// Mock github client
vi.mock("../../src/app/services/github", () => ({
  getClient: vi.fn(),
}));

// Mock auth store — onAuthCleared is called at poll.ts module scope
vi.mock("../../src/app/stores/auth", () => ({
  user: vi.fn(() => ({ login: "octocat", avatar_url: "https://github.com/images/error/octocat_happy.gif", name: "Octocat" })),
  onAuthCleared: vi.fn(),
}));

// Mock API functions
vi.mock("../../src/app/services/api", () => ({
  fetchIssuesAndPullRequests: vi.fn(),
  fetchWorkflowRuns: vi.fn(),
  fetchHotPRStatus: vi.fn(),
  fetchWorkflowRunById: vi.fn(),
  pooledAllSettled: vi.fn(),
  resetEmptyActionRepos: vi.fn(),
}));

// Mock notifications — spy on _resetNotificationState
vi.mock("../../src/app/lib/notifications", () => ({
  detectNewItems: vi.fn(() => []),
  dispatchNotifications: vi.fn(),
  _resetNotificationState: mockResetNotifState,
}));

// Mock errors store
vi.mock("../../src/app/lib/errors", () => ({
  pushError: vi.fn(),
  pushNotification: vi.fn(),
  getErrors: vi.fn().mockReturnValue([]),
  dismissError: vi.fn(),
  getNotifications: vi.fn().mockReturnValue([]),
  getUnreadCount: vi.fn().mockReturnValue(0),
  markAllAsRead: vi.fn(),
  startCycleTracking: vi.fn(),
  endCycleTracking: vi.fn(),
  resetNotificationState: vi.fn(),
  dismissNotificationBySource: vi.fn(),
}));

// Use REAL config store — the reactive effects in poll.ts subscribe to this
import { updateConfig, resetConfig } from "../../src/app/stores/config";

// Import poll.ts — triggers createRoot + createEffect registration at module scope
import "../../src/app/services/poll";

describe("poll.ts — notification reset reactive effects", () => {
  beforeEach(() => {
    resetConfig();
    mockResetNotifState.mockClear();
  });

  it("resets notification state when monitoredRepos changes", () => {
    updateConfig({
      selectedRepos: [{ owner: "org", name: "repo", fullName: "org/repo" }],
      monitoredRepos: [{ owner: "org", name: "repo", fullName: "org/repo" }],
    });

    expect(mockResetNotifState).toHaveBeenCalled();
  });

  it("resets notification state when trackedUsers changes", () => {
    updateConfig({
      trackedUsers: [{
        login: "octocat",
        avatarUrl: "https://avatars.githubusercontent.com/u/583231",
        name: "Octocat",
        type: "user" as const,
      }],
    });

    expect(mockResetNotifState).toHaveBeenCalled();
  });

  it("does not reset when config update does not change the key", () => {
    updateConfig({ theme: "dark" });

    expect(mockResetNotifState).not.toHaveBeenCalled();
  });

  it("resets notification state when monitoredRepos cleared to empty", () => {
    updateConfig({
      selectedRepos: [{ owner: "org", name: "repo", fullName: "org/repo" }],
      monitoredRepos: [{ owner: "org", name: "repo", fullName: "org/repo" }],
    });
    mockResetNotifState.mockClear();

    updateConfig({ monitoredRepos: [] });

    expect(mockResetNotifState).toHaveBeenCalled();
  });

  it("detects swap at same array length (key-based comparison)", () => {
    updateConfig({
      selectedRepos: [
        { owner: "org", name: "a", fullName: "org/a" },
        { owner: "org", name: "b", fullName: "org/b" },
      ],
      monitoredRepos: [{ owner: "org", name: "a", fullName: "org/a" }],
    });
    mockResetNotifState.mockClear();

    updateConfig({
      monitoredRepos: [{ owner: "org", name: "b", fullName: "org/b" }],
    });

    expect(mockResetNotifState).toHaveBeenCalled();
  });
});

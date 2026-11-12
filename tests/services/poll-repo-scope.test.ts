import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";

// poll.ts registers its config-change effects once, at module load. This suite keeps the real
// (reactive) config store so those effects actually run, and spies on the two resets they trigger.
const mockResetNotificationState = vi.hoisted(() => vi.fn());
const mockResetEventsState = vi.hoisted(() => vi.fn());

vi.mock("../../src/app/lib/notifications", () => ({
  detectNewItems: vi.fn(() => []),
  dispatchNotifications: vi.fn(),
  _resetNotificationState: mockResetNotificationState,
}));

vi.mock("../../src/app/services/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/services/events")>();
  return { ...actual, resetEventsState: mockResetEventsState };
});

vi.mock("../../src/app/services/github", () => ({
  getClient: vi.fn(() => null),
  fetchRateLimitDetails: vi.fn(() => Promise.resolve(null)),
  onApiRequest: vi.fn(),
  initClientWatcher: vi.fn(),
}));

import "../../src/app/services/poll";
import { config, resetConfig, updateConfig } from "../../src/app/stores/config";

const REPO_A = { owner: "org", name: "repo-a", fullName: "org/repo-a" };
const REPO_B = { owner: "org", name: "repo-b", fullName: "org/repo-b" };

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("poll repo-scope reset effect", () => {
  beforeEach(async () => {
    resetConfig();
    await settle();
    mockResetNotificationState.mockClear();
    mockResetEventsState.mockClear();
  });

  it("resets notification and events state when a repo is added to selectedRepos", async () => {
    updateConfig({ selectedRepos: [REPO_A] });
    await settle();

    expect(mockResetNotificationState).toHaveBeenCalled();
    expect(mockResetEventsState).toHaveBeenCalled();
  });

  it("resets when upstreamRepos change", async () => {
    updateConfig({ upstreamRepos: [REPO_B] });
    await settle();

    expect(mockResetNotificationState).toHaveBeenCalledTimes(1);
    expect(mockResetEventsState).toHaveBeenCalledTimes(1);
  });

  it("does not reset when the same repos are written again in a different order", async () => {
    updateConfig({ selectedRepos: [REPO_A, REPO_B] });
    await settle();
    mockResetNotificationState.mockClear();
    mockResetEventsState.mockClear();

    updateConfig({ selectedRepos: [REPO_B, REPO_A] });
    await settle();

    expect(config.selectedRepos).toHaveLength(2);
    expect(mockResetNotificationState).not.toHaveBeenCalled();
    expect(mockResetEventsState).not.toHaveBeenCalled();
  });

  it("does not reset for unrelated config changes", async () => {
    updateConfig({ refreshInterval: 120 });
    await settle();

    expect(mockResetNotificationState).not.toHaveBeenCalled();
    expect(mockResetEventsState).not.toHaveBeenCalled();
  });
});

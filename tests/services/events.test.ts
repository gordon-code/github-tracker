import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock auth store — events.ts calls onAuthCleared() at module scope
vi.mock("../../src/app/stores/auth", () => ({
  onAuthCleared: vi.fn(),
  user: vi.fn(() => null),
}));

// Mock github module (not directly used by events.ts, but imported transitively)
vi.mock("../../src/app/services/github", () => ({
  getClient: vi.fn(() => null),
}));

// Import AFTER mocks
import { fetchUserEvents, parseRepoEvents, resetEventsState } from "../../src/app/services/events";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOctokit(requestImpl: (...args: unknown[]) => unknown) {
  return {
    request: vi.fn(requestImpl),
    hook: { before: vi.fn() },
  };
}

function makeEvent(overrides: {
  id?: string;
  type?: string;
  repoName?: string;
  created_at?: string;
} = {}) {
  return {
    id: overrides.id ?? "100",
    type: overrides.type ?? "PushEvent",
    actor: { id: 1, login: "user" },
    repo: { id: 1, name: overrides.repoName ?? "owner/repo" },
    payload: {},
    created_at: overrides.created_at ?? "2026-01-01T00:00:00Z",
  };
}

// ── fetchUserEvents ───────────────────────────────────────────────────────────

describe("fetchUserEvents", () => {
  beforeEach(() => {
    resetEventsState();
    vi.clearAllMocks();
  });

  it("returns events and changed=true on 200 response", async () => {
    const event = makeEvent({ id: "500" });
    const octokit = makeOctokit(() =>
      Promise.resolve({
        data: [event],
        headers: { etag: '"abc123"' },
      })
    );

    const result = await fetchUserEvents(octokit as never, "someuser");

    expect(result.changed).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe("500");
  });

  it("returns empty events and changed=false on 304", async () => {
    const octokit = makeOctokit(() => Promise.reject({ status: 304 }));

    const result = await fetchUserEvents(octokit as never, "someuser");

    expect(result.changed).toBe(false);
    expect(result.events).toHaveLength(0);
  });

  it("returns empty events and changed=false on network error without throwing", async () => {
    const octokit = makeOctokit(() => Promise.reject(new Error("Network failure")));

    const result = await fetchUserEvents(octokit as never, "someuser");

    expect(result.changed).toBe(false);
    expect(result.events).toHaveLength(0);
  });

  it("sends If-None-Match header on second call after ETag received", async () => {
    const octokit = makeOctokit(() =>
      Promise.resolve({
        data: [makeEvent({ id: "200" })],
        headers: { etag: '"etag-value"' },
      })
    );

    // First call — seeds ETag
    await fetchUserEvents(octokit as never, "someuser");

    // Second call — ETag should be sent
    await fetchUserEvents(octokit as never, "someuser");

    const secondCallHeaders = (octokit.request.mock.calls[1][1] as { headers?: Record<string, string> }).headers ?? {};
    expect(secondCallHeaders["If-None-Match"]).toBe('"etag-value"');
  });

  it("does NOT send If-None-Match on first call", async () => {
    const octokit = makeOctokit(() =>
      Promise.resolve({ data: [], headers: {} })
    );

    await fetchUserEvents(octokit as never, "someuser");

    const firstCallHeaders = (octokit.request.mock.calls[0][1] as { headers?: Record<string, string> }).headers ?? {};
    expect(firstCallHeaders["If-None-Match"]).toBeUndefined();
  });

  it("returns all events on first call (no ID filter)", async () => {
    const events = [
      makeEvent({ id: "300" }),
      makeEvent({ id: "299" }),
      makeEvent({ id: "298" }),
    ];
    const octokit = makeOctokit(() =>
      Promise.resolve({ data: events, headers: {} })
    );

    const result = await fetchUserEvents(octokit as never, "someuser");

    expect(result.events).toHaveLength(3);
    expect(result.changed).toBe(true);
  });

  it("filters to only events with IDs > lastEventId on subsequent calls", async () => {
    // First call: seed lastEventId = "300"
    const firstOctokit = makeOctokit(() =>
      Promise.resolve({
        data: [makeEvent({ id: "300" })],
        headers: {},
      })
    );
    await fetchUserEvents(firstOctokit as never, "someuser");

    // Second call: events with IDs 301 (new) and 299 (old)
    const secondOctokit = makeOctokit(() =>
      Promise.resolve({
        data: [makeEvent({ id: "301" }), makeEvent({ id: "299" })],
        headers: {},
      })
    );
    const result = await fetchUserEvents(secondOctokit as never, "someuser");

    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe("301");
    expect(result.changed).toBe(true);
  });

  it("uses numeric comparison for event ID filtering (not lexicographic)", async () => {
    // Seed with lastEventId = "9"
    const firstOctokit = makeOctokit(() =>
      Promise.resolve({ data: [makeEvent({ id: "9" })], headers: {} })
    );
    await fetchUserEvents(firstOctokit as never, "someuser");

    // "10" > "9" numerically but NOT lexicographically
    const secondOctokit = makeOctokit(() =>
      Promise.resolve({
        data: [makeEvent({ id: "10" }), makeEvent({ id: "8" })],
        headers: {},
      })
    );
    const result = await fetchUserEvents(secondOctokit as never, "someuser");

    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe("10");
  });

  it("returns changed=false when no new events since last ID", async () => {
    // First call: seed lastEventId = "500"
    const firstOctokit = makeOctokit(() =>
      Promise.resolve({ data: [makeEvent({ id: "500" })], headers: {} })
    );
    await fetchUserEvents(firstOctokit as never, "someuser");

    // Second call: no new events (all IDs <= 500)
    const secondOctokit = makeOctokit(() =>
      Promise.resolve({
        data: [makeEvent({ id: "500" }), makeEvent({ id: "499" })],
        headers: {},
      })
    );
    const result = await fetchUserEvents(secondOctokit as never, "someuser");

    expect(result.changed).toBe(false);
    expect(result.events).toHaveLength(0);
  });

  it("returns empty events and changed=false for empty username (SEC-IMPL-001)", async () => {
    const octokit = makeOctokit(() => Promise.resolve({ data: [], headers: {} }));

    const result = await fetchUserEvents(octokit as never, "");

    expect(result.changed).toBe(false);
    expect(result.events).toHaveLength(0);
    expect(octokit.request).not.toHaveBeenCalled();
  });
});

// ── parseRepoEvents ───────────────────────────────────────────────────────────

describe("parseRepoEvents", () => {
  it("returns empty map for empty events array", () => {
    const result = parseRepoEvents([], new Set(["owner/repo"]));
    expect(result.size).toBe(0);
  });

  it("filters out events for untracked repos", () => {
    const events = [
      makeEvent({ type: "IssuesEvent", repoName: "owner/tracked" }),
      makeEvent({ type: "IssuesEvent", repoName: "owner/untracked" }),
    ];
    const result = parseRepoEvents(events, new Set(["owner/tracked"]));

    expect(result.size).toBe(1);
    expect([...result.keys()]).toContain("owner/tracked");
  });

  it("filters out non-actionable event types", () => {
    const events = [
      makeEvent({ type: "CreateEvent", repoName: "owner/repo" }),
      makeEvent({ type: "DeleteEvent", repoName: "owner/repo" }),
      makeEvent({ type: "WatchEvent", repoName: "owner/repo" }),
    ];
    const result = parseRepoEvents(events, new Set(["owner/repo"]));

    expect(result.size).toBe(0);
  });

  it("sets hasIssueActivity for IssuesEvent and IssueCommentEvent", () => {
    const events = [
      makeEvent({ type: "IssuesEvent", repoName: "owner/repo" }),
      makeEvent({ type: "IssueCommentEvent", repoName: "owner/repo" }),
    ];
    const result = parseRepoEvents(events, new Set(["owner/repo"]));
    const summary = result.get("owner/repo")!;

    expect(summary.hasIssueActivity).toBe(true);
    expect(summary.hasPRActivity).toBe(false);
    expect(summary.hasWorkflowActivity).toBe(false);
  });

  it("sets hasPRActivity for PullRequestEvent, PullRequestReviewEvent, PullRequestReviewCommentEvent", () => {
    const events = [
      makeEvent({ type: "PullRequestEvent", repoName: "owner/repo" }),
      makeEvent({ type: "PullRequestReviewEvent", repoName: "owner/repo" }),
      makeEvent({ type: "PullRequestReviewCommentEvent", repoName: "owner/repo" }),
    ];
    const result = parseRepoEvents(events, new Set(["owner/repo"]));
    const summary = result.get("owner/repo")!;

    expect(summary.hasPRActivity).toBe(true);
    expect(summary.hasIssueActivity).toBe(false);
  });

  it("sets hasWorkflowActivity for PushEvent", () => {
    const events = [makeEvent({ type: "PushEvent", repoName: "owner/repo" })];
    const result = parseRepoEvents(events, new Set(["owner/repo"]));

    expect(result.get("owner/repo")!.hasWorkflowActivity).toBe(true);
  });

  it("does case-insensitive repo matching: Owner/Repo vs owner/repo", () => {
    const events = [
      makeEvent({ type: "IssuesEvent", repoName: "Owner/Repo" }),
    ];
    const result = parseRepoEvents(events, new Set(["owner/repo"]));

    expect(result.size).toBe(1);
  });

  it("picks the max timestamp for latestEventAt", () => {
    const events = [
      makeEvent({ type: "IssuesEvent", repoName: "owner/repo", created_at: "2026-01-01T10:00:00Z" }),
      makeEvent({ type: "PushEvent", repoName: "owner/repo", created_at: "2026-01-01T12:00:00Z" }),
      makeEvent({ type: "PullRequestEvent", repoName: "owner/repo", created_at: "2026-01-01T08:00:00Z" }),
    ];
    const result = parseRepoEvents(events, new Set(["owner/repo"]));

    expect(result.get("owner/repo")!.latestEventAt).toBe("2026-01-01T12:00:00Z");
  });

  it("groups multiple events for the same repo into one summary", () => {
    const events = [
      makeEvent({ type: "IssuesEvent", repoName: "owner/repo" }),
      makeEvent({ type: "PushEvent", repoName: "owner/repo" }),
    ];
    const result = parseRepoEvents(events, new Set(["owner/repo"]));

    expect(result.size).toBe(1);
    const summary = result.get("owner/repo")!;
    expect(summary.hasIssueActivity).toBe(true);
    expect(summary.hasWorkflowActivity).toBe(true);
    expect(summary.eventTypes.size).toBe(2);
  });

  it("handles mix of event types across tracked and untracked repos", () => {
    const events = [
      makeEvent({ type: "IssuesEvent", repoName: "owner/a" }),
      makeEvent({ type: "PushEvent", repoName: "owner/b" }),
      makeEvent({ type: "PullRequestEvent", repoName: "owner/c" }), // untracked
      makeEvent({ type: "CreateEvent", repoName: "owner/a" }),      // non-actionable
    ];
    const result = parseRepoEvents(events, new Set(["owner/a", "owner/b"]));

    expect(result.size).toBe(2);
    expect(result.get("owner/a")!.hasIssueActivity).toBe(true);
    expect(result.get("owner/b")!.hasWorkflowActivity).toBe(true);
  });
});

// ── resetEventsState ──────────────────────────────────────────────────────────

describe("resetEventsState", () => {
  it("clears ETag so next call sends no If-None-Match header", async () => {
    const octokit = makeOctokit(() =>
      Promise.resolve({
        data: [makeEvent({ id: "100" })],
        headers: { etag: '"etag-123"' },
      })
    );

    // First call — seeds ETag
    await fetchUserEvents(octokit as never, "someuser");

    // Reset
    resetEventsState();

    // Next call should have no If-None-Match
    await fetchUserEvents(octokit as never, "someuser");

    const thirdCallHeaders = (octokit.request.mock.calls[1][1] as { headers?: Record<string, string> }).headers ?? {};
    expect(thirdCallHeaders["If-None-Match"]).toBeUndefined();
  });

  it("clears lastEventId so next call returns all events (first-call semantics)", async () => {
    // First call: seed lastEventId = "100"
    const firstOctokit = makeOctokit(() =>
      Promise.resolve({ data: [makeEvent({ id: "100" })], headers: {} })
    );
    await fetchUserEvents(firstOctokit as never, "someuser");

    // Reset
    resetEventsState();

    // After reset, next call should behave like first call (return all events, not filter)
    const secondOctokit = makeOctokit(() =>
      Promise.resolve({
        data: [makeEvent({ id: "100" }), makeEvent({ id: "99" })],
        headers: {},
      })
    );
    const result = await fetchUserEvents(secondOctokit as never, "someuser");

    // All events returned — no ID filtering since _lastEventId was cleared
    expect(result.events).toHaveLength(2);
    expect(result.changed).toBe(true);
  });
});

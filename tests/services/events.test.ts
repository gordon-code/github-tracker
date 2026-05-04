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
        headers: {},
      })
    );

    const result = await fetchUserEvents(octokit as never, "someuser");

    expect(result.changed).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe("500");
  });

  it("returns empty events and changed=false on proxy 304 without throwing", async () => {
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

  it("does not send If-None-Match header on subsequent calls", async () => {
    const octokit = makeOctokit(() =>
      Promise.resolve({
        data: [makeEvent({ id: "200" })],
        headers: {},
      })
    );

    await fetchUserEvents(octokit as never, "someuser");
    await fetchUserEvents(octokit as never, "someuser");

    const secondCallHeaders = (octokit.request.mock.calls[1][1] as { headers?: Record<string, string> }).headers ?? {};
    expect(secondCallHeaders["If-None-Match"]).toBeUndefined();
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

  it("advances _lastEventId to max ID even when highest ID is not first in response", async () => {
    const firstOctokit = makeOctokit(() =>
      Promise.resolve({ data: [makeEvent({ id: "100" })], headers: {} })
    );
    await fetchUserEvents(firstOctokit as never, "someuser");

    // Response with out-of-order IDs: highest (305) is not first
    const secondOctokit = makeOctokit(() =>
      Promise.resolve({
        data: [makeEvent({ id: "301" }), makeEvent({ id: "305" }), makeEvent({ id: "302" })],
        headers: {},
      })
    );
    await fetchUserEvents(secondOctokit as never, "someuser");

    // Third call: only events > 305 should appear (not > 301)
    const thirdOctokit = makeOctokit(() =>
      Promise.resolve({
        data: [makeEvent({ id: "306" }), makeEvent({ id: "304" }), makeEvent({ id: "303" })],
        headers: {},
      })
    );
    const result = await fetchUserEvents(thirdOctokit as never, "someuser");

    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe("306");
    expect(result.changed).toBe(true);
  });

  it("returns empty events and changed=false for empty username (SEC-IMPL-001)", async () => {
    const octokit = makeOctokit(() => Promise.resolve({ data: [], headers: {} }));

    const result = await fetchUserEvents(octokit as never, "");

    expect(result.changed).toBe(false);
    expect(result.events).toHaveLength(0);
    expect(octokit.request).not.toHaveBeenCalled();
  });
});

describe("fetchUserEvents — pagination", () => {
  beforeEach(() => {
    resetEventsState();
    vi.clearAllMocks();
  });

  it("fetches page 2 when page 1 returns exactly 100 events and merges results", async () => {
    const page1Events = Array.from({ length: 100 }, (_, i) =>
      makeEvent({ id: String(1000 + i) })
    );
    const page2Events = [makeEvent({ id: "900" }), makeEvent({ id: "901" })];

    const octokit = makeOctokit(() => Promise.resolve({ data: [], headers: {} }));
    octokit.request
      .mockImplementationOnce(() => Promise.resolve({ data: page1Events, headers: {} }))
      .mockImplementationOnce(() => Promise.resolve({ data: page2Events, headers: {} }));

    const result = await fetchUserEvents(octokit as never, "someuser");

    expect(octokit.request).toHaveBeenCalledTimes(2);
    expect(result.events).toHaveLength(102);
    expect(result.changed).toBe(true);
  });

  it("does not fetch page 2 when page 1 returns fewer than 100 events", async () => {
    const page1Events = [makeEvent({ id: "500" }), makeEvent({ id: "501" })];

    const octokit = makeOctokit(() =>
      Promise.resolve({ data: page1Events, headers: {} })
    );

    await fetchUserEvents(octokit as never, "someuser");

    expect(octokit.request).toHaveBeenCalledTimes(1);
  });

  it("fetches up to page 3 when pages 1 and 2 are both full, but not page 4", async () => {
    const page1Events = Array.from({ length: 100 }, (_, i) =>
      makeEvent({ id: String(3000 + i) })
    );
    const page2Events = Array.from({ length: 100 }, (_, i) =>
      makeEvent({ id: String(2000 + i) })
    );
    const page3Events = [makeEvent({ id: "1000" }), makeEvent({ id: "1001" })];

    const octokit = makeOctokit(() => Promise.resolve({ data: [], headers: {} }));
    octokit.request
      .mockImplementationOnce(() => Promise.resolve({ data: page1Events, headers: {} }))
      .mockImplementationOnce(() => Promise.resolve({ data: page2Events, headers: {} }))
      .mockImplementationOnce(() => Promise.resolve({ data: page3Events, headers: {} }));

    const result = await fetchUserEvents(octokit as never, "someuser");

    expect(octokit.request).toHaveBeenCalledTimes(3);
    expect(result.events).toHaveLength(202);
    expect(result.changed).toBe(true);
  });

  it("skips page 2 when _lastEventId is set and all page 1 events are not newer", async () => {
    // Seed _lastEventId = "500"
    const seedOctokit = makeOctokit(() =>
      Promise.resolve({ data: [makeEvent({ id: "500" })], headers: {} })
    );
    await fetchUserEvents(seedOctokit as never, "someuser");

    const page1Events = Array.from({ length: 100 }, (_, i) =>
      makeEvent({ id: String(400 + i) }) // IDs 400–499, all <= 500
    );
    const octokit = makeOctokit(() => Promise.resolve({ data: [], headers: {} }));
    octokit.request.mockImplementationOnce(() =>
      Promise.resolve({ data: page1Events, headers: {} })
    );

    const result = await fetchUserEvents(octokit as never, "someuser");

    expect(octokit.request).toHaveBeenCalledTimes(1);
    expect(result.changed).toBe(false);
    expect(result.events).toHaveLength(0);
  });

  it("returns page 1 results and logs warning when page 2 request fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const page1Events = Array.from({ length: 100 }, (_, i) =>
      makeEvent({ id: String(1000 + i) })
    );

    const octokit = makeOctokit(() => Promise.resolve({ data: [], headers: {} }));
    octokit.request
      .mockImplementationOnce(() => Promise.resolve({ data: page1Events, headers: {} }))
      .mockImplementationOnce(() => Promise.reject(new Error("rate limited")));

    const result = await fetchUserEvents(octokit as never, "someuser");

    expect(octokit.request).toHaveBeenCalledTimes(2);
    expect(result.events).toHaveLength(100);
    expect(result.changed).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      "[events] pagination error on page 2:",
      "rate limited",
    );

    warnSpy.mockRestore();
  });

  it("stops pagination when subsequent page returns zero events", async () => {
    const page1Events = Array.from({ length: 100 }, (_, i) =>
      makeEvent({ id: String(1000 + i) })
    );

    const octokit = makeOctokit(() => Promise.resolve({ data: [], headers: {} }));
    octokit.request
      .mockImplementationOnce(() => Promise.resolve({ data: page1Events, headers: {} }))
      .mockImplementationOnce(() => Promise.resolve({ data: [], headers: {} }));

    const result = await fetchUserEvents(octokit as never, "someuser");

    expect(octokit.request).toHaveBeenCalledTimes(2);
    expect(result.events).toHaveLength(100);
    expect(result.changed).toBe(true);
  });

  it("triggers early-exit when page has mix of new and old events", async () => {
    // Seed _lastEventId = "500"
    const seedOctokit = makeOctokit(() =>
      Promise.resolve({ data: [makeEvent({ id: "500" })], headers: {} })
    );
    await fetchUserEvents(seedOctokit as never, "someuser");

    // Page 1: 100 events straddling the threshold — IDs 450–549
    // Events 501–549 are new (above 500), events 450–500 are old
    const page1Events = Array.from({ length: 100 }, (_, i) =>
      makeEvent({ id: String(450 + i) })
    );
    const octokit = makeOctokit(() => Promise.resolve({ data: [], headers: {} }));
    octokit.request.mockImplementationOnce(() =>
      Promise.resolve({ data: page1Events, headers: {} })
    );

    const result = await fetchUserEvents(octokit as never, "someuser");

    // Early-exit fires: page has old events (450–500), so page 2 is not fetched
    expect(octokit.request).toHaveBeenCalledTimes(1);
    // New events (501–549) are still returned from page 1
    expect(result.events).toHaveLength(49);
    expect(result.changed).toBe(true);
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

  it("sets hasPRActivity and hasWorkflowActivity for PushEvent", () => {
    const events = [makeEvent({ type: "PushEvent", repoName: "owner/repo" })];
    const result = parseRepoEvents(events, new Set(["owner/repo"]));

    expect(result.get("owner/repo")!.hasWorkflowActivity).toBe(true);
    expect(result.get("owner/repo")!.hasPRActivity).toBe(true);
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

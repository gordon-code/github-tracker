import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { clearCache } from "../../src/app/stores/cache";

const mockPushNotification = vi.fn();
const mockDismissNotificationBySource = vi.fn();
vi.mock("../../src/app/lib/errors", () => ({
  pushNotification: (...args: unknown[]) => mockPushNotification(...args),
  dismissNotificationBySource: (source: string) => mockDismissNotificationBySource(source),
}));

import {
  fetchGitHubStatus,
  getGitHubStatus,
  resetGitHubStatusState,
  TRACKED_COMPONENT_NAMES,
} from "../../src/app/services/github-status";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeComponent(name: string, status = "operational") {
  return { id: `id-${name.replace(/\s+/g, "-").toLowerCase()}`, name, status };
}

function makeIncident(overrides: {
  id: string;
  name: string;
  body: string;
  componentNames: string[];
  componentStatus?: string;
}) {
  return {
    id: overrides.id,
    name: overrides.name,
    incident_updates: [{ body: overrides.body }],
    components: overrides.componentNames.map((n) => makeComponent(n, overrides.componentStatus ?? "major_outage")),
  };
}

function makeSummary(overrides?: { components?: unknown[]; incidents?: unknown[] }) {
  return {
    page: { id: "test-page", name: "GitHub", url: "https://www.githubstatus.com" },
    status: { indicator: "none", description: "All Systems Operational" },
    components: overrides?.components ?? [...TRACKED_COMPONENT_NAMES].map((n) => makeComponent(n)),
    incidents: overrides?.incidents ?? [],
  };
}

function jsonResponse(body: unknown, init?: { status?: number; etag?: string }) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init?.etag) headers["ETag"] = init.etag;
  return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("fetchGitHubStatus", () => {
  beforeEach(async () => {
    await clearCache();
    resetGitHubStatusState();
    mockPushNotification.mockClear();
    mockDismissNotificationBySource.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("parses a successful 200 response into a GitHubStatusSummary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeSummary())));

    await fetchGitHubStatus();

    const result = getGitHubStatus();
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("none");
    expect(result!.incidents).toEqual([]);
    expect(result!.fetchedAt).toBeInstanceOf(Date);
  });

  it("blends to critical severity when Actions has a major_outage and other tracked components are operational, and notifies", async () => {
    const components = [...TRACKED_COMPONENT_NAMES].map((n) =>
      makeComponent(n, n === "Actions" ? "major_outage" : "operational")
    );
    const incidents = [makeIncident({ id: "inc-1", name: "Actions Outage", body: "Investigating", componentNames: ["Actions"] })];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeSummary({ components, incidents }))));

    await fetchGitHubStatus();

    const result = getGitHubStatus();
    expect(result!.severity).toBe("critical");
    expect(result!.incidents).toHaveLength(1);
    expect(mockPushNotification).toHaveBeenCalledWith("github-status", "Actions Outage", "error", false);
  });

  it("returns severity none with no incidents when all tracked components are operational", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeSummary())));

    await fetchGitHubStatus();

    const result = getGitHubStatus();
    expect(result!.severity).toBe("none");
    expect(result!.incidents).toEqual([]);
  });

  it("excludes an incident whose only affected component is untracked (Copilot)", async () => {
    const incidents = [makeIncident({ id: "inc-copilot", name: "Copilot Degraded", body: "Investigating", componentNames: ["Copilot"] })];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeSummary({ incidents }))));

    await fetchGitHubStatus();

    const result = getGitHubStatus();
    expect(result!.incidents).toEqual([]);
    expect(result!.severity).toBe("none");
    expect(mockPushNotification).not.toHaveBeenCalledWith("github-status", expect.anything(), expect.anything(), expect.anything());
  });

  it("severity isolation: an untracked component's major_outage does not blend into severity", async () => {
    const components = [
      ...[...TRACKED_COMPONENT_NAMES].map((n) => makeComponent(n, "operational")),
      makeComponent("Pages", "major_outage"),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeSummary({ components, incidents: [] }))));

    await fetchGitHubStatus();

    const result = getGitHubStatus();
    expect(result!.severity).toBe("none");
    expect(result!.incidents).toEqual([]);
  });

  it("floors severity at minor when an incident is still open but its tracked components blend to operational (CR-001)", async () => {
    // Statuspage's "Monitoring" phase: component status resets to operational
    // while the incident itself remains open and still affects a tracked
    // component — severity must not fall back to "none" in that window.
    const incidents = [makeIncident({
      id: "monitoring-1",
      name: "Actions Degradation",
      body: "We are continuing to monitor.",
      componentNames: ["Actions"],
      componentStatus: "operational",
    })];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeSummary({ incidents }))));

    await fetchGitHubStatus();

    const result = getGitHubStatus();
    expect(result!.severity).toBe("minor");
    expect(result!.incidents).toHaveLength(1);
  });

  it("dismisses the github-status notification and pushes a resolved notification when an incident clears", async () => {
    const incidents = [makeIncident({ id: "abc", name: "Actions Outage", body: "Investigating", componentNames: ["Actions"] })];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeSummary({ incidents }))));
    await fetchGitHubStatus();

    mockPushNotification.mockClear();
    mockDismissNotificationBySource.mockClear();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeSummary({ incidents: [] }))));
    await fetchGitHubStatus();

    expect(mockDismissNotificationBySource).toHaveBeenCalledWith("github-status");
    expect(mockPushNotification).toHaveBeenCalledWith("github-status-resolved", "Actions Outage", "info", false);
  });

  it("two consecutive resolutions with different incident names each produce a distinct notification", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeSummary({
      incidents: [makeIncident({ id: "a", name: "Incident A", body: "x", componentNames: ["Actions"] })],
    }))));
    await fetchGitHubStatus();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeSummary({
      incidents: [makeIncident({ id: "b", name: "Incident B", body: "y", componentNames: ["Issues"] })],
    }))));
    mockPushNotification.mockClear();
    await fetchGitHubStatus();
    expect(mockPushNotification).toHaveBeenCalledWith("github-status-resolved", "Incident A", "info", false);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeSummary({ incidents: [] }))));
    mockPushNotification.mockClear();
    await fetchGitHubStatus();
    expect(mockPushNotification).toHaveBeenCalledWith("github-status-resolved", "Incident B", "info", false);
  });

  it("strips HTML tags from the latest update body", async () => {
    const incidents = [makeIncident({
      id: "abc",
      name: "Actions Outage",
      body: "Update - We are continuing to investigate.<br /><br />",
      componentNames: ["Actions"],
    })];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeSummary({ incidents }))));

    await fetchGitHubStatus();

    const result = getGitHubStatus();
    expect(result!.incidents[0].latestUpdateBody).not.toContain("<br");
  });

  it("pins the raw, unescaped incident name through to pushNotification (toast/drawer escaping boundary)", async () => {
    const xssName = "<img src=x onerror=alert(1)>";
    const incidents = [makeIncident({ id: "xss-1", name: xssName, body: "Investigating", componentNames: ["Actions"] })];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeSummary({ incidents }))));

    await fetchGitHubStatus();

    expect(mockPushNotification).toHaveBeenCalledWith("github-status", xssName, expect.any(String), false);
  });

  it("sends credentials: omit and cache: no-store on the outgoing fetch", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(makeSummary()));
    vi.stubGlobal("fetch", mockFetch);

    await fetchGitHubStatus();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://www.githubstatus.com/api/v2/summary.json",
      expect.objectContaining({ credentials: "omit", cache: "no-store" })
    );
  });

  it("includes an AbortSignal (from AbortSignal.timeout) on the outgoing fetch call", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(makeSummary()));
    vi.stubGlobal("fetch", mockFetch);

    await fetchGitHubStatus();

    const options = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("is a no-op when called again while a prior call's fetch is still in flight", async () => {
    let resolveFetch!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const mockFetch = vi.fn().mockReturnValue(pending);
    vi.stubGlobal("fetch", mockFetch);

    const first = fetchGitHubStatus();
    const second = fetchGitHubStatus();

    resolveFetch(jsonResponse(makeSummary()));
    await Promise.all([first, second]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("304 cache-hit path: reflects parseSummary run against the cached JSON, not empty/null", async () => {
    const incidents = [makeIncident({ id: "cached-1", name: "Cached Incident", body: "Investigating", componentNames: ["Actions"] })];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeSummary({ incidents }), { etag: "etag-1" })));
    await fetchGitHubStatus();
    expect(getGitHubStatus()!.incidents).toHaveLength(1);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 304 })));
    await fetchGitHubStatus();

    const result = getGitHubStatus();
    expect(result!.incidents).toHaveLength(1);
    expect(result!.incidents[0].name).toBe("Cached Incident");
  });

  it("keeps the prior value on a single fetch failure and does not dismiss the notification (CR-002)", async () => {
    const incidents = [makeIncident({ id: "x", name: "X", body: "y", componentNames: ["Actions"] })];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeSummary({ incidents }))));
    await fetchGitHubStatus();
    const before = getGitHubStatus();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    mockDismissNotificationBySource.mockClear();
    mockPushNotification.mockClear();
    await expect(fetchGitHubStatus()).resolves.toBeUndefined();

    expect(getGitHubStatus()).toEqual(before);
    expect(mockDismissNotificationBySource).not.toHaveBeenCalled();

    // A subsequent successful poll with the same unchanged incident must not
    // look like a fresh announcement — it should be pushed with the exact same
    // source+message as before, which the real errors.ts dedup treats as a no-op.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeSummary({ incidents }))));
    await fetchGitHubStatus();
    expect(mockPushNotification).toHaveBeenCalledTimes(1);
    expect(mockPushNotification).toHaveBeenCalledWith("github-status", "X", "warning", false);
  });

  it("dismisses the notification only after 3 consecutive fetch failures (CR-002)", async () => {
    const incidents = [makeIncident({ id: "x", name: "X", body: "y", componentNames: ["Actions"] })];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeSummary({ incidents }))));
    await fetchGitHubStatus();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    mockDismissNotificationBySource.mockClear();

    await fetchGitHubStatus(); // failure 1
    expect(mockDismissNotificationBySource).not.toHaveBeenCalled();
    await fetchGitHubStatus(); // failure 2
    expect(mockDismissNotificationBySource).not.toHaveBeenCalled();
    await fetchGitHubStatus(); // failure 3
    expect(mockDismissNotificationBySource).toHaveBeenCalledWith("github-status");
  });

  it("resets the consecutive-failure counter after a successful fetch (CR-002)", async () => {
    const incidents = [makeIncident({ id: "x", name: "X", body: "y", componentNames: ["Actions"] })];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeSummary({ incidents }))));
    await fetchGitHubStatus();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await fetchGitHubStatus(); // failure 1
    await fetchGitHubStatus(); // failure 2

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeSummary({ incidents }))));
    await fetchGitHubStatus(); // success — must reset the counter

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    mockDismissNotificationBySource.mockClear();
    await fetchGitHubStatus(); // failure 1 (post-reset)
    await fetchGitHubStatus(); // failure 2 (post-reset)

    // If the counter hadn't reset, this would be the 4th consecutive failure
    // overall and would already have crossed the threshold.
    expect(mockDismissNotificationBySource).not.toHaveBeenCalled();
  });

  it("first call with no successful fetch yet leaves getGitHubStatus() at null on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await fetchGitHubStatus();

    expect(getGitHubStatus()).toBeNull();
  });

  it("logs a schema-drift warning without throwing, and does not dismiss the notification on a single failure", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ components: "not-an-array", incidents: [] })));

    await expect(fetchGitHubStatus()).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("schema drift"), expect.anything());
    expect(mockDismissNotificationBySource).not.toHaveBeenCalled();
    expect(getGitHubStatus()).toBeNull();
  });

  it("keeps the prior value on a single schema-drift failure and does not dismiss the notification", async () => {
    const incidents = [makeIncident({ id: "x", name: "X", body: "y", componentNames: ["Actions"] })];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeSummary({ incidents }))));
    await fetchGitHubStatus();
    const before = getGitHubStatus();

    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ components: "not-an-array", incidents: [] })));
    mockDismissNotificationBySource.mockClear();

    await expect(fetchGitHubStatus()).resolves.toBeUndefined();

    expect(getGitHubStatus()).toEqual(before);
    expect(mockDismissNotificationBySource).not.toHaveBeenCalled();
  });

  it("dismisses the notification after 3 consecutive schema-drift failures, sharing the counter with network failures", async () => {
    const incidents = [makeIncident({ id: "x", name: "X", body: "y", componentNames: ["Actions"] })];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeSummary({ incidents }))));
    await fetchGitHubStatus();

    vi.spyOn(console, "warn").mockImplementation(() => {});
    const badResponse = () => jsonResponse({ components: "not-an-array", incidents: [] });
    mockDismissNotificationBySource.mockClear();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(badResponse()));
    await fetchGitHubStatus(); // schema failure 1
    expect(mockDismissNotificationBySource).not.toHaveBeenCalled();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await fetchGitHubStatus(); // network failure 2 — shares the same counter

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(badResponse()));
    await fetchGitHubStatus(); // schema failure 3
    expect(mockDismissNotificationBySource).toHaveBeenCalledWith("github-status");
  });
});

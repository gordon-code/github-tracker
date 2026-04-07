// ── MCP relay client unit tests ───────────────────────────────────────────────
// Tests the SPA-side relay module (src/app/lib/mcp-relay.ts).
// WebSocket is mocked via a class constructor — happy-dom has no functional WebSocket.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeIssue, makePullRequest, makeWorkflowRun } from "../../helpers/factories";

// ── Module-level mocks ─────────────────────────────────────────────────────────

const mockConfigStore = {
  mcpRelayEnabled: true,
  mcpRelayPort: 9876,
  selectedRepos: [{ owner: "owner", name: "repo", fullName: "owner/repo" }],
  trackedUsers: [],
  upstreamRepos: [],
  monitoredRepos: [],
};

vi.mock("../../../src/app/stores/config", () => ({
  get config() {
    return mockConfigStore;
  },
}));

let _mockCoreRateLimit: { limit: number; remaining: number; resetAt: Date } | null = null;
let _mockGraphqlRateLimit: { limit: number; remaining: number; resetAt: Date } | null = null;

vi.mock("../../../src/app/services/github", () => ({
  getCoreRateLimit: () => _mockCoreRateLimit,
  getGraphqlRateLimit: () => _mockGraphqlRateLimit,
}));

// ── Mock WebSocket factory ─────────────────────────────────────────────────────

interface MockWs {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onopen: ((e: Event) => void) | null;
  onmessage: ((e: MessageEvent) => void) | null;
  onclose: ((e: CloseEvent) => void) | null;
  onerror: ((e: Event) => void) | null;
  _triggerOpen(): void;
  _triggerMessage(data: string): void;
  _triggerClose(): void;
}

/**
 * Creates a single-instance WebSocket mock. The Constructor is a real class
 * that can be called with `new`, returning the shared instance.
 */
function makeSingleInstanceMock(): { ws: MockWs; Constructor: typeof WebSocket } {
  const ws: MockWs = {
    readyState: 0,
    send: vi.fn(),
    close: vi.fn().mockImplementation(function (this: MockWs) {
      this.readyState = 3;
    }),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    _triggerOpen() {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    },
    _triggerMessage(data: string) {
      this.onmessage?.(new MessageEvent("message", { data }));
    },
    _triggerClose() {
      this.readyState = 3;
      this.onclose?.(new CloseEvent("close", { code: 1000, reason: "" }));
    },
  };

  // Using Object.assign on the prototype to make `new Constructor()` return `ws`
  function MockWsCtor(this: MockWs) {
    return ws;
  }
  MockWsCtor.OPEN = 1;
  MockWsCtor.CONNECTING = 0;
  MockWsCtor.CLOSING = 2;
  MockWsCtor.CLOSED = 3;

  return { ws, Constructor: MockWsCtor as unknown as typeof WebSocket };
}

/**
 * Creates a multi-instance WebSocket mock for reconnect/backoff tests.
 */
function makeMultiInstanceMock(): { instances: MockWs[]; Constructor: typeof WebSocket } {
  const instances: MockWs[] = [];

  function MockWsCtor(this: MockWs) {
    const ws: MockWs = {
      readyState: 0,
      send: vi.fn(),
      close: vi.fn().mockImplementation(function (this: MockWs) {
        this.readyState = 3;
      }),
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      _triggerOpen() {
        this.readyState = 1;
        this.onopen?.(new Event("open"));
      },
      _triggerMessage(data: string) {
        this.onmessage?.(new MessageEvent("message", { data }));
      },
      _triggerClose() {
        this.readyState = 3;
        this.onclose?.(new CloseEvent("close", { code: 1000, reason: "" }));
      },
    };
    instances.push(ws);
    return ws;
  }
  MockWsCtor.OPEN = 1;
  MockWsCtor.CONNECTING = 0;
  MockWsCtor.CLOSING = 2;
  MockWsCtor.CLOSED = 3;

  return { instances, Constructor: MockWsCtor as unknown as typeof WebSocket };
}

// ── Helper: load module fresh and set up mock WS ──────────────────────────────

async function loadModule(Constructor: typeof WebSocket) {
  vi.resetModules();
  vi.stubGlobal("WebSocket", Constructor);
  // Stub window.addEventListener for the module-level pagehide/beforeunload handlers
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  return import("../../../src/app/lib/mcp-relay");
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("updateRelaySnapshot / handleRequest", () => {
  let mod: typeof import("../../../src/app/lib/mcp-relay");
  let ws: MockWs;

  beforeEach(async () => {
    const mock = makeSingleInstanceMock();
    ws = mock.ws;
    mod = await loadModule(mock.Constructor);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    _mockCoreRateLimit = null;
    _mockGraphqlRateLimit = null;
  });

  it("stores snapshot and returns PRs via GET_OPEN_PRS", () => {
    const issues = [makeIssue({ state: "open" })];
    const prs = [makePullRequest({ state: "open", repoFullName: "owner/repo" })];
    const runs = [makeWorkflowRun({ conclusion: "success" })];

    mod.updateRelaySnapshot({ issues, pullRequests: prs, workflowRuns: runs, lastUpdatedAt: Date.now() });

    const responses: string[] = [];
    ws.send = vi.fn((data: string) => responses.push(data));

    mod.connectRelay(9876);
    ws._triggerOpen();

    ws._triggerMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "get_open_prs",
      params: {},
    }));

    const prResponse = responses.find((r) => (JSON.parse(r) as { id?: number }).id === 1);
    expect(prResponse).toBeDefined();
    const parsed = JSON.parse(prResponse!) as { result: unknown[] };
    expect(parsed.result).toHaveLength(1);
  });

  it("returns -32002 error when snapshot is null and method needs it", () => {
    // No updateRelaySnapshot called — _snapshot is null
    const responses: string[] = [];
    ws.send = vi.fn((data: string) => responses.push(data));

    mod.connectRelay(9876);
    ws._triggerOpen();

    ws._triggerMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "get_dashboard_summary",
      params: { scope: "involves_me" },
    }));

    const response = responses.find((r) => (JSON.parse(r) as { id?: number }).id === 2);
    expect(response).toBeDefined();
    const parsed = JSON.parse(response!) as { error: { code: number; message: string } };
    expect(parsed.error.code).toBe(-32002);
    expect(parsed.error.message).toContain("not yet loaded");
  });

  it("returns -32601 for unknown method", () => {
    mod.updateRelaySnapshot({
      issues: [],
      pullRequests: [],
      workflowRuns: [],
      lastUpdatedAt: Date.now(),
    });

    const responses: string[] = [];
    ws.send = vi.fn((data: string) => responses.push(data));

    mod.connectRelay(9876);
    ws._triggerOpen();

    ws._triggerMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "completely_unknown_method",
      params: {},
    }));

    const response = responses.find((r) => (JSON.parse(r) as { id?: number }).id === 3);
    expect(response).toBeDefined();
    const parsed = JSON.parse(response!) as { error: { code: number } };
    expect(parsed.error.code).toBe(-32601);
  });
});

describe("GET_DASHBOARD_SUMMARY handler", () => {
  let mod: typeof import("../../../src/app/lib/mcp-relay");
  let ws: MockWs;

  beforeEach(async () => {
    const mock = makeSingleInstanceMock();
    ws = mock.ws;
    mod = await loadModule(mock.Constructor);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("computes correct summary counts from snapshot", () => {
    const issues = [
      makeIssue({ state: "open" }),
      makeIssue({ state: "open" }),
      makeIssue({ state: "closed" }),
    ];
    const prs = [
      makePullRequest({ state: "open", reviewDecision: "REVIEW_REQUIRED" }),
      makePullRequest({ state: "open", reviewDecision: "APPROVED" }),
      makePullRequest({ state: "closed" }),
    ];
    const runs = [
      makeWorkflowRun({ conclusion: "failure" }),
      makeWorkflowRun({ conclusion: "timed_out" }),
      makeWorkflowRun({ conclusion: "success" }),
    ];

    mod.updateRelaySnapshot({ issues, pullRequests: prs, workflowRuns: runs, lastUpdatedAt: Date.now() });

    const responses: string[] = [];
    ws.send = vi.fn((data: string) => responses.push(data));

    mod.connectRelay(9876);
    ws._triggerOpen();

    ws._triggerMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "get_dashboard_summary",
      params: { scope: "involves_me" },
    }));

    const response = responses.find((r) => (JSON.parse(r) as { id?: number }).id === 10);
    expect(response).toBeDefined();
    const parsed = JSON.parse(response!) as {
      result: {
        openIssueCount: number;
        openPRCount: number;
        failingRunCount: number;
        needsReviewCount: number;
        approvedUnmergedCount: number;
      };
    };
    expect(parsed.result.openIssueCount).toBe(2);
    expect(parsed.result.openPRCount).toBe(2);
    expect(parsed.result.failingRunCount).toBe(2);
    expect(parsed.result.needsReviewCount).toBe(1);
    expect(parsed.result.approvedUnmergedCount).toBe(1);
  });
});

describe("GET_OPEN_PRS repo filter", () => {
  let mod: typeof import("../../../src/app/lib/mcp-relay");
  let ws: MockWs;

  beforeEach(async () => {
    const mock = makeSingleInstanceMock();
    ws = mock.ws;
    mod = await loadModule(mock.Constructor);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("filters by repo when repo param is provided", () => {
    const pr1 = makePullRequest({ state: "open", repoFullName: "owner/repo-a" });
    const pr2 = makePullRequest({ state: "open", repoFullName: "owner/repo-b" });
    mod.updateRelaySnapshot({ issues: [], pullRequests: [pr1, pr2], workflowRuns: [], lastUpdatedAt: Date.now() });

    const responses: string[] = [];
    ws.send = vi.fn((data: string) => responses.push(data));
    mod.connectRelay(9876);
    ws._triggerOpen();

    ws._triggerMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 20,
      method: "get_open_prs",
      params: { repo: "owner/repo-a" },
    }));

    const response = responses.find((r) => (JSON.parse(r) as { id?: number }).id === 20);
    const parsed = JSON.parse(response!) as { result: unknown[] };
    expect(parsed.result).toHaveLength(1);
  });

  it("returns all open PRs when no filter is provided", () => {
    const prs = [
      makePullRequest({ state: "open" }),
      makePullRequest({ state: "open" }),
      makePullRequest({ state: "closed" }),
    ];
    mod.updateRelaySnapshot({ issues: [], pullRequests: prs, workflowRuns: [], lastUpdatedAt: Date.now() });

    const responses: string[] = [];
    ws.send = vi.fn((data: string) => responses.push(data));
    mod.connectRelay(9876);
    ws._triggerOpen();

    ws._triggerMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 21,
      method: "get_open_prs",
      params: {},
    }));

    const response = responses.find((r) => (JSON.parse(r) as { id?: number }).id === 21);
    const parsed = JSON.parse(response!) as { result: unknown[] };
    expect(parsed.result).toHaveLength(2);
  });
});

describe("GET_PR_DETAILS handler", () => {
  let mod: typeof import("../../../src/app/lib/mcp-relay");
  let ws: MockWs;

  beforeEach(async () => {
    const mock = makeSingleInstanceMock();
    ws = mock.ws;
    mod = await loadModule(mock.Constructor);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns PR by repo+number", () => {
    const pr = makePullRequest({ number: 42, repoFullName: "owner/repo", state: "open" });
    mod.updateRelaySnapshot({ issues: [], pullRequests: [pr], workflowRuns: [], lastUpdatedAt: Date.now() });

    const responses: string[] = [];
    ws.send = vi.fn((data: string) => responses.push(data));
    mod.connectRelay(9876);
    ws._triggerOpen();

    ws._triggerMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 30,
      method: "get_pr_details",
      params: { repo: "owner/repo", number: 42 },
    }));

    const response = responses.find((r) => (JSON.parse(r) as { id?: number }).id === 30);
    const parsed = JSON.parse(response!) as { result: { number: number } };
    expect(parsed.result.number).toBe(42);
  });

  it("returns -32002 error when PR not found", () => {
    mod.updateRelaySnapshot({ issues: [], pullRequests: [], workflowRuns: [], lastUpdatedAt: Date.now() });

    const responses: string[] = [];
    ws.send = vi.fn((data: string) => responses.push(data));
    mod.connectRelay(9876);
    ws._triggerOpen();

    ws._triggerMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 31,
      method: "get_pr_details",
      params: { repo: "owner/repo", number: 9999 },
    }));

    const response = responses.find((r) => (JSON.parse(r) as { id?: number }).id === 31);
    const parsed = JSON.parse(response!) as { error: { code: number; message: string } };
    expect(parsed.error.code).toBe(-32002);
    expect(parsed.error.message).toContain("not found");
  });
});

describe("GET_RATE_LIMIT handler", () => {
  let mod: typeof import("../../../src/app/lib/mcp-relay");
  let ws: MockWs;

  beforeEach(async () => {
    _mockCoreRateLimit = null;
    _mockGraphqlRateLimit = null;
    const mock = makeSingleInstanceMock();
    ws = mock.ws;
    mod = await loadModule(mock.Constructor);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    _mockCoreRateLimit = null;
    _mockGraphqlRateLimit = null;
  });

  it("returns -32002 when no rate limit data available", () => {
    // Both are null
    const responses: string[] = [];
    ws.send = vi.fn((data: string) => responses.push(data));
    mod.connectRelay(9876);
    ws._triggerOpen();

    ws._triggerMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 40,
      method: "get_rate_limit",
      params: {},
    }));

    const response = responses.find((r) => (JSON.parse(r) as { id?: number }).id === 40);
    const parsed = JSON.parse(response!) as { error: { code: number } };
    expect(parsed.error.code).toBe(-32002);
  });

  it("returns rate limit data when available", () => {
    _mockCoreRateLimit = { limit: 5000, remaining: 4000, resetAt: new Date("2026-04-07T12:00:00Z") };

    const responses: string[] = [];
    ws.send = vi.fn((data: string) => responses.push(data));
    mod.connectRelay(9876);
    ws._triggerOpen();

    ws._triggerMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 41,
      method: "get_rate_limit",
      params: {},
    }));

    const response = responses.find((r) => (JSON.parse(r) as { id?: number }).id === 41);
    const parsed = JSON.parse(response!) as { result: { core: { limit: number; remaining: number } } };
    expect(parsed.result.core.limit).toBe(5000);
    expect(parsed.result.core.remaining).toBe(4000);
  });
});

describe("connectRelay — config update on connect", () => {
  let mod: typeof import("../../../src/app/lib/mcp-relay");
  let ws: MockWs;
  let WsCtor: typeof WebSocket;

  beforeEach(async () => {
    const mock = makeSingleInstanceMock();
    ws = mock.ws;
    WsCtor = mock.Constructor;
    mod = await loadModule(WsCtor);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends config_update notification when connection opens", () => {
    const sentMessages: string[] = [];
    ws.send = vi.fn((data: string) => sentMessages.push(data));

    mod.connectRelay(9876);
    ws._triggerOpen();

    // First sent message should be a config_update notification
    expect(sentMessages.length).toBeGreaterThan(0);
    const configMsg = sentMessages.find((m) => (JSON.parse(m) as { method?: string }).method === "config_update");
    expect(configMsg).toBeDefined();
    // BUG-001 fix: params are flat (no config: wrapper) to match ConfigUpdatePayloadSchema.
    const parsed = JSON.parse(configMsg!) as { params: { selectedRepos: unknown[] } };
    expect(parsed.params.selectedRepos).toBeDefined();
  });

  it("uses the WebSocket constructor with the correct URL", () => {
    const constructorCalls: string[] = [];
    // Wrap the constructor to track calls
    const TrackingCtor = function (url: string) {
      constructorCalls.push(url);
      return ws;
    } as unknown as typeof WebSocket;
    (TrackingCtor as { OPEN: number }).OPEN = 1;
    (TrackingCtor as { CONNECTING: number }).CONNECTING = 0;
    (TrackingCtor as { CLOSING: number }).CLOSING = 2;
    (TrackingCtor as { CLOSED: number }).CLOSED = 3;
    vi.stubGlobal("WebSocket", TrackingCtor);

    mod.connectRelay(9876);
    expect(constructorCalls[constructorCalls.length - 1]).toBe("ws://127.0.0.1:9876");
  });
});

describe("disconnectRelay — skips reconnect", () => {
  let mod: typeof import("../../../src/app/lib/mcp-relay");
  let ws: MockWs;

  beforeEach(async () => {
    const mock = makeSingleInstanceMock();
    ws = mock.ws;
    mod = await loadModule(mock.Constructor);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("closes WebSocket and sets status to disconnected", () => {
    mod.connectRelay(9876);
    ws._triggerOpen();
    expect(mod.getRelayStatus()).toBe("connected");

    mod.disconnectRelay();
    expect(mod.getRelayStatus()).toBe("disconnected");
    expect(ws.close).toHaveBeenCalled();
  });
});

describe("backoff reconnect sequence", () => {
  let mod: typeof import("../../../src/app/lib/mcp-relay");
  let instances: MockWs[];

  beforeEach(async () => {
    vi.useFakeTimers();
    const mock = makeMultiInstanceMock();
    instances = mock.instances;
    mod = await loadModule(mock.Constructor);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reconnects after 1s on first disconnect (initial backoff)", async () => {
    mod.connectRelay(9876);
    expect(instances).toHaveLength(1);

    // Trigger open (resets backoffIndex to 0) then close (schedules 1s reconnect)
    instances[0]._triggerOpen();
    instances[0]._triggerClose();
    expect(instances).toHaveLength(1); // Still 1 right after close

    // After 1s: first reconnect fires
    vi.advanceTimersByTime(1000);
    expect(instances).toHaveLength(2);
  });

  it("increases backoff on repeated failures without successful open", async () => {
    mod.connectRelay(9876);

    // First close without opening — schedules reconnect at 1s (backoffIndex=0)
    instances[0]._triggerClose();
    vi.advanceTimersByTime(1000);
    expect(instances).toHaveLength(2);

    // Second close without opening — schedules reconnect at 10s (backoffIndex=1)
    instances[1]._triggerClose();
    vi.advanceTimersByTime(9999);
    expect(instances).toHaveLength(2); // Not yet (needs 10000ms)

    vi.advanceTimersByTime(1);
    expect(instances).toHaveLength(3);
  });

  it("resets backoff index on successful connection", async () => {
    mod.connectRelay(9876);
    expect(instances).toHaveLength(1);

    // Open and close — first reconnect at 1s
    instances[0]._triggerOpen();
    instances[0]._triggerClose();

    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();
    expect(instances).toHaveLength(2);

    // Second connection opens successfully — resets backoff to 0
    instances[1]._triggerOpen();

    // Close — should reconnect at 1s again
    instances[1]._triggerClose();

    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();
    expect(instances).toHaveLength(3);
  });

  it("does not reconnect after deliberate disconnect", async () => {
    mod.connectRelay(9876);
    instances[0]._triggerOpen();

    mod.disconnectRelay();

    // Advance far past any backoff delay
    vi.advanceTimersByTime(400000);
    await vi.runAllTimersAsync();

    // Should still only have the initial connection attempt
    expect(instances).toHaveLength(1);
  });
});

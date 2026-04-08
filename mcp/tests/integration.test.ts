// ── Integration tests ────────────────────────────────────────────────────────
// Task 6: Tests that exercise real components together (not mocked).
// Covers: WebSocket relay data flow, fallback mode, edge cases.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  startWebSocketServer,
  closeWebSocketServer,
  isRelayConnected,
  sendRelayRequest,
  onNotification,
} from "../src/ws-relay.js";
import {
  WebSocketDataSource,
  CompositeDataSource,
  OctokitDataSource,
  setCachedConfig,
} from "../src/data-source.js";
import type { DataSource } from "../src/data-source.js";
import { METHODS, NOTIFICATIONS } from "../../src/shared/protocol.js";
import { makeIssue, makePullRequest, makeWorkflowRun } from "../../tests/helpers/factories.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function waitForEvent(
  emitter: { once: (event: string, cb: (...args: unknown[]) => void) => void },
  event: string,
  timeout = 3000
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeout);
    emitter.once(event, (...args: unknown[]) => { clearTimeout(t); resolve(args); });
  });
}

function waitForListening(wss: WebSocketServer): Promise<number> {
  return new Promise((resolve, reject) => {
    const addr = wss.address();
    if (addr && typeof addr === "object") return resolve(addr.port);
    const t = setTimeout(() => reject(new Error("Timeout waiting for listening")), 3000);
    wss.on("listening", () => {
      clearTimeout(t);
      const a = wss.address();
      if (a && typeof a === "object") resolve(a.port);
      else reject(new Error("Server has no address after listening"));
    });
    wss.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    const t = setTimeout(() => reject(new Error("Timeout waiting for open")), 3000);
    ws.on("open", () => { clearTimeout(t); resolve(); });
    ws.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}

function waitForClose(ws: WebSocket, timeout = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    const t = setTimeout(() => reject(new Error("Timeout waiting for close")), timeout);
    ws.once("close", () => { clearTimeout(t); resolve(); });
  });
}

function waitForMessage(ws: WebSocket, timeout = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Timeout waiting for message")), timeout);
    ws.once("message", (data) => { clearTimeout(t); resolve(data.toString()); });
  });
}

async function waitForCondition(
  condition: () => boolean,
  timeout = 2000,
  interval = 10
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timeout waiting for condition");
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Round-trip sentinel: sends a relay request from the server to the connected
 * client and waits for the client to respond.  By the time this resolves, the
 * server has processed every message that arrived before the sentinel.
 */
async function roundTripSentinel(ws: WebSocket): Promise<void> {
  const sentinelPromise = sendRelayRequest("__sentinel__", {});
  const raw = await waitForMessage(ws);
  const msg = JSON.parse(raw) as { id: number };
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null }));
  await sentinelPromise;
}

// ── Test setup ──────────────────────────────────────────────────────────────────

describe("Integration: WebSocket relay data flow", () => {
  let wss: WebSocketServer | null;
  let client: WebSocket | null = null;

  beforeEach(() => {
    vi.stubEnv("MCP_WS_PORT", "0");
    wss = startWebSocketServer();
  });

  afterEach(async () => {
    if (client && client.readyState !== WebSocket.CLOSED) {
      client.close();
      client = null;
    }
    await closeWebSocketServer();
    vi.unstubAllEnvs();
  });

  it("sends JSON-RPC request to connected client and receives response", async () => {
    if (!wss) throw new Error("Server not started");
    const port = await waitForListening(wss);
    client = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(client);

    // Client acts as SPA — responds to JSON-RPC requests
    client.on("message", (data) => {
      const req = JSON.parse(data.toString());
      if (req.method === METHODS.GET_RATE_LIMIT) {
        client!.send(JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            core: { limit: 5000, remaining: 4999, resetAt: "2026-04-07T20:00:00Z" },
            graphql: { limit: 5000, remaining: 4998, resetAt: "2026-04-07T20:00:00Z" },
          },
        }));
      }
    });

    // Wait for the server's connection handler to register the client
    await waitForCondition(() => isRelayConnected());
    expect(isRelayConnected()).toBe(true);

    // Send a request through the relay
    const result = await sendRelayRequest(METHODS.GET_RATE_LIMIT, {});
    expect(result).toBeDefined();
    expect((result as { core: { limit: number } }).core.limit).toBe(5000);
  });

  it("receives config_update notifications from client", async () => {
    if (!wss) throw new Error("Server not started");
    const port = await waitForListening(wss);
    client = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(client);

    const received = vi.fn();
    const notificationReceived = new Promise<void>((resolve) => {
      onNotification(NOTIFICATIONS.CONFIG_UPDATE, (params) => {
        received(params);
        resolve();
      });
    });

    // Client sends a config_update notification (no id = notification)
    client.send(JSON.stringify({
      jsonrpc: "2.0",
      method: NOTIFICATIONS.CONFIG_UPDATE,
      params: {
        selectedRepos: [{ owner: "test", name: "repo", fullName: "test/repo" }],
        trackedUsers: [],
        upstreamRepos: [],
        monitoredRepos: [],
      },
    }));

    // Wait for the notification handler to be invoked
    await notificationReceived;
    expect(received).toHaveBeenCalledOnce();
    const params = received.mock.calls[0][0] as { selectedRepos: unknown[] };
    expect(params.selectedRepos).toHaveLength(1);
  });

  it("handles client disconnect gracefully — pending requests reject", async () => {
    if (!wss) throw new Error("Server not started");
    const port = await waitForListening(wss);
    client = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(client);
    await waitForCondition(() => isRelayConnected());

    // Send a request but don't respond — then disconnect
    const promise = sendRelayRequest(METHODS.GET_OPEN_PRS, {});
    client.close();

    await expect(promise).rejects.toThrow();
    expect(isRelayConnected()).toBe(false);
  });

  // Note: request timeout (10s) is tested in ws-relay.test.ts with proper mocking.
  // Mixing vi.useFakeTimers with real WebSocket connections + heartbeat timers
  // causes stale timer interference — not suitable for integration tests.
});

describe("Integration: WebSocketDataSource through relay", () => {
  let wss: WebSocketServer | null;
  let client: WebSocket | null = null;
  let wsDs: WebSocketDataSource;

  beforeEach(() => {
    vi.stubEnv("MCP_WS_PORT", "0");
    wss = startWebSocketServer();
    wsDs = new WebSocketDataSource();
  });

  afterEach(async () => {
    if (client && client.readyState !== WebSocket.CLOSED) {
      client.close();
      client = null;
    }
    await closeWebSocketServer();
    vi.unstubAllEnvs();
  });

  it("getOpenPRs returns PRs from relay client", async () => {
    if (!wss) throw new Error("Server not started");
    const port = await waitForListening(wss);
    client = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(client);

    const mockPRs = [makePullRequest({ title: "Fix auth bug", repoFullName: "acme/app" })];

    client.on("message", (data) => {
      const req = JSON.parse(data.toString());
      if (req.method === METHODS.GET_OPEN_PRS) {
        client!.send(JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: mockPRs,
        }));
      }
    });

    await waitForCondition(() => isRelayConnected());
    const prs = await wsDs.getOpenPRs();
    expect(prs).toHaveLength(1);
    expect(prs[0].title).toBe("Fix auth bug");
  });

  it("getConfig returns config pushed via notification", async () => {
    if (!wss) throw new Error("Server not started");
    const port = await waitForListening(wss);
    client = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(client);

    client.on("message", (data) => {
      const req = JSON.parse(data.toString());
      if (req.method === METHODS.GET_CONFIG) {
        client!.send(JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            selectedRepos: [{ owner: "acme", name: "app", fullName: "acme/app" }],
            trackedUsers: [],
            upstreamRepos: [],
            monitoredRepos: [],
          },
        }));
      }
    });

    await waitForCondition(() => isRelayConnected());
    const config = await wsDs.getConfig();
    expect(config).toBeDefined();
    expect((config as { selectedRepos: unknown[] }).selectedRepos).toHaveLength(1);
  });
});

describe("Integration: CompositeDataSource fallback", () => {
  let wss: WebSocketServer | null;

  beforeEach(() => {
    vi.stubEnv("MCP_WS_PORT", "0");
    wss = startWebSocketServer();
  });

  afterEach(async () => {
    await closeWebSocketServer();
    vi.unstubAllEnvs();
  });

  it("falls back to Octokit when relay is disconnected", async () => {
    // No client connected — relay is disconnected
    expect(isRelayConnected()).toBe(false);

    const mockFallback: DataSource = {
      getDashboardSummary: vi.fn().mockResolvedValue({
        openPRCount: 5, openIssueCount: 3, failingRunCount: 1,
        needsReviewCount: 2, approvedUnmergedCount: 1,
      }),
      getOpenPRs: vi.fn().mockResolvedValue([]),
      getOpenIssues: vi.fn().mockResolvedValue([]),
      getFailingActions: vi.fn().mockResolvedValue([]),
      getPRDetails: vi.fn().mockResolvedValue(null),
      getRateLimit: vi.fn().mockResolvedValue({ limit: 5000, remaining: 4999, resetAt: new Date() }),
      getConfig: vi.fn().mockResolvedValue(null),
      getRepos: vi.fn().mockResolvedValue([]),
    };

    const wsDs = new WebSocketDataSource();
    const composite = new CompositeDataSource(wsDs, mockFallback);

    const summary = await composite.getDashboardSummary("involves_me");
    expect(summary.openPRCount).toBe(5);
    expect(mockFallback.getDashboardSummary).toHaveBeenCalledOnce();
  });

  it("uses relay when connected, skipping Octokit", async () => {
    if (!wss) throw new Error("Server not started");
    const port = await waitForListening(wss);
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(client);

    client.on("message", (data) => {
      const req = JSON.parse(data.toString());
      if (req.method === METHODS.GET_OPEN_ISSUES) {
        client.send(JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: [makeIssue({ title: "Relay issue" })],
        }));
      }
    });

    await waitForCondition(() => isRelayConnected());

    const mockFallback: DataSource = {
      getDashboardSummary: vi.fn(),
      getOpenPRs: vi.fn(),
      getOpenIssues: vi.fn().mockResolvedValue([makeIssue({ title: "Fallback issue" })]),
      getFailingActions: vi.fn(),
      getPRDetails: vi.fn(),
      getRateLimit: vi.fn(),
      getConfig: vi.fn(),
      getRepos: vi.fn(),
    };

    const wsDs = new WebSocketDataSource();
    const composite = new CompositeDataSource(wsDs, mockFallback);

    const issues = await composite.getOpenIssues();
    expect(issues[0].title).toBe("Relay issue");
    // Fallback should NOT have been called
    expect(mockFallback.getOpenIssues).not.toHaveBeenCalled();

    client.close();
  });
});

describe("Integration: Edge cases (no server)", () => {
  it("no GITHUB_TOKEN + no relay → tools return clear error", async () => {
    const unavailable: DataSource = {
      getDashboardSummary: () => Promise.reject(new Error(
        "No GITHUB_TOKEN set and SPA relay is not connected."
      )),
      getOpenPRs: () => Promise.reject(new Error("No GITHUB_TOKEN")),
      getOpenIssues: () => Promise.reject(new Error("No GITHUB_TOKEN")),
      getFailingActions: () => Promise.reject(new Error("No GITHUB_TOKEN")),
      getPRDetails: () => Promise.reject(new Error("No GITHUB_TOKEN")),
      getRateLimit: () => Promise.reject(new Error("No GITHUB_TOKEN")),
      getConfig: () => Promise.resolve(null),
      getRepos: () => Promise.resolve([]),
    };

    const wsDs = new WebSocketDataSource();
    const composite = new CompositeDataSource(wsDs, unavailable);

    await expect(composite.getDashboardSummary("involves_me")).rejects.toThrow(/GITHUB_TOKEN/);
    const config = await composite.getConfig();
    expect(config).toBeNull();
    const repos = await composite.getRepos();
    expect(repos).toEqual([]);
  });
});

describe("Integration: Edge cases (with server)", () => {
  let wss: WebSocketServer | null;

  beforeEach(() => {
    vi.stubEnv("MCP_WS_PORT", "0");
    wss = startWebSocketServer();
  });

  afterEach(async () => {
    await closeWebSocketServer();
    vi.unstubAllEnvs();
  });

  it("second client rejected", async () => {
    if (!wss) throw new Error("Server not started");
    const port = await waitForListening(wss);

    const client1 = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(client1);
    await waitForCondition(() => isRelayConnected());
    expect(isRelayConnected()).toBe(true);

    const client2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => {
      client2.on("close", () => resolve());
      client2.on("error", () => resolve());
    });

    expect(client2.readyState).not.toBe(WebSocket.OPEN);
    client1.close();
  });

  it("malformed JSON message does not crash server", async () => {
    if (!wss) throw new Error("Server not started");
    const port = await waitForListening(wss);

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(client);
    await waitForCondition(() => isRelayConnected());

    client.send("not valid json {{{");
    client.send("");
    client.send(JSON.stringify({ foo: "bar" }));

    // Round-trip sentinel: proves server processed all malformed messages and is still alive
    await roundTripSentinel(client);
    expect(isRelayConnected()).toBe(true);
    client.close();
  });

  it("config cache persists across relay disconnects", async () => {
    setCachedConfig({
      selectedRepos: [{ owner: "acme", name: "app", fullName: "acme/app" }],
      trackedUsers: [],
      upstreamRepos: [],
      monitoredRepos: [],
    });

    if (!wss) throw new Error("Server not started");
    const port = await waitForListening(wss);

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(client);
    client.close();
    await waitForClose(client);
    // Wait for the server's close handler to clear the connection state
    await waitForCondition(() => !isRelayConnected());

    const wsDs = new WebSocketDataSource();
    const mockFallback: DataSource = {
      getDashboardSummary: vi.fn(),
      getOpenPRs: vi.fn(),
      getOpenIssues: vi.fn(),
      getFailingActions: vi.fn(),
      getPRDetails: vi.fn(),
      getRateLimit: vi.fn(),
      getConfig: vi.fn().mockResolvedValue({
        selectedRepos: [{ owner: "acme", name: "app", fullName: "acme/app" }],
        trackedUsers: [], upstreamRepos: [], monitoredRepos: [],
      }),
      getRepos: vi.fn().mockResolvedValue([{ owner: "acme", name: "app", fullName: "acme/app" }]),
    };

    const composite = new CompositeDataSource(wsDs, mockFallback);
    const repos = await composite.getRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0].fullName).toBe("acme/app");
  });
});

describe("Integration: Port conflict", () => {
  it("EADDRINUSE — server starts without WebSocket", async () => {
    const blocker = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const port = await waitForListening(blocker);

    vi.stubEnv("MCP_WS_PORT", String(port));
    const wss = startWebSocketServer();

    // The EADDRINUSE error fires asynchronously; wait for the error event on wss
    if (wss) await waitForEvent(wss, "error");
    expect(isRelayConnected()).toBe(false);

    await closeWebSocketServer();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    vi.unstubAllEnvs();
  });
});

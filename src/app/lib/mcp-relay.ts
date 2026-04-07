// ── MCP WebSocket relay client ────────────────────────────────────────────────
// Browser-side relay that exposes dashboard data to a local MCP server.
// No @modelcontextprotocol/sdk dependency — plain WebSocket + JSON-RPC 2.0.

import { createSignal, createEffect } from "solid-js";
import { METHODS, NOTIFICATIONS } from "../../shared/protocol";
import { config } from "../stores/config";
import { getCoreRateLimit, getGraphqlRateLimit } from "../services/github";
import type { Issue, PullRequest, WorkflowRun } from "../../shared/types";

// ── Types ─────────────────────────────────────────────────────────────────────

interface RelaySnapshot {
  issues: Issue[];
  pullRequests: PullRequest[];
  workflowRuns: WorkflowRun[];
  lastUpdatedAt: number;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

// ── State ─────────────────────────────────────────────────────────────────────

const BACKOFF_MS = [1000, 10000, 30000, 60000, 300000] as const;

let _ws: WebSocket | null = null;
let _deliberateDisconnect = false;
let _backoffIndex = 0;
let _backoffTimer: ReturnType<typeof setTimeout> | null = null;
let _snapshot: RelaySnapshot | null = null;

const [_relayStatus, _setRelayStatus] = createSignal<"connected" | "connecting" | "disconnected">("disconnected");

export function getRelayStatus(): "connected" | "connecting" | "disconnected" {
  return _relayStatus();
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

export function updateRelaySnapshot(data: {
  issues: Issue[];
  pullRequests: PullRequest[];
  workflowRuns: WorkflowRun[];
  lastUpdatedAt: number;
}): void {
  _snapshot = { ...data };
}

function getRelaySnapshot(): RelaySnapshot | null {
  return _snapshot;
}

// ── WebSocket connection ───────────────────────────────────────────────────────

function clearBackoffTimer(): void {
  if (_backoffTimer !== null) {
    clearTimeout(_backoffTimer);
    _backoffTimer = null;
  }
}

function sendConfigUpdate(ws: WebSocket): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const notification = {
    jsonrpc: "2.0",
    method: NOTIFICATIONS.CONFIG_UPDATE,
    params: {
      config: {
        selectedRepos: config.selectedRepos,
        trackedUsers: config.trackedUsers,
        upstreamRepos: config.upstreamRepos,
        monitoredRepos: config.monitoredRepos,
      },
    },
  };
  ws.send(JSON.stringify(notification));
}

function sendResponse(ws: WebSocket, response: JsonRpcResponse): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(response));
}

function handleRequest(ws: WebSocket, req: JsonRpcRequest): void {
  const id = req.id;

  const snapshot = getRelaySnapshot();

  // Methods that need snapshot first
  const snapshotMethods: string[] = [
    METHODS.GET_DASHBOARD_SUMMARY,
    METHODS.GET_OPEN_PRS,
    METHODS.GET_OPEN_ISSUES,
    METHODS.GET_FAILING_ACTIONS,
    METHODS.GET_PR_DETAILS,
  ];

  if (snapshotMethods.includes(req.method) && !snapshot) {
    sendResponse(ws, {
      jsonrpc: "2.0",
      id,
      error: { code: -32002, message: "Dashboard data not yet loaded" },
    });
    return;
  }

  switch (req.method) {
    case METHODS.GET_DASHBOARD_SUMMARY: {
      const s = snapshot!;
      const openPRs = s.pullRequests.filter((p) => p.state === "open");
      const result = {
        openPRCount: openPRs.length,
        openIssueCount: s.issues.filter((i) => i.state === "open").length,
        failingRunCount: s.workflowRuns.filter(
          (r) => r.conclusion === "failure" || r.conclusion === "timed_out"
        ).length,
        needsReviewCount: openPRs.filter((p) => p.reviewDecision === "REVIEW_REQUIRED").length,
        approvedUnmergedCount: openPRs.filter((p) => p.reviewDecision === "APPROVED").length,
      };
      sendResponse(ws, { jsonrpc: "2.0", id, result });
      break;
    }

    case METHODS.GET_OPEN_PRS: {
      const params = req.params ?? {};
      let prs = snapshot!.pullRequests.filter((p) => p.state === "open");
      if (typeof params["repo"] === "string" && params["repo"]) {
        prs = prs.filter((p) => p.repoFullName === params["repo"]);
      }
      if (typeof params["status"] === "string" && params["status"]) {
        const status = params["status"];
        prs = prs.filter((p) => p.checkStatus === status);
      }
      sendResponse(ws, { jsonrpc: "2.0", id, result: prs });
      break;
    }

    case METHODS.GET_OPEN_ISSUES: {
      const params = req.params ?? {};
      let issues = snapshot!.issues.filter((i) => i.state === "open");
      if (typeof params["repo"] === "string" && params["repo"]) {
        issues = issues.filter((i) => i.repoFullName === params["repo"]);
      }
      sendResponse(ws, { jsonrpc: "2.0", id, result: issues });
      break;
    }

    case METHODS.GET_FAILING_ACTIONS: {
      const params = req.params ?? {};
      let runs = snapshot!.workflowRuns.filter(
        (r) => r.conclusion === "failure" || r.conclusion === "timed_out"
      );
      if (typeof params["repo"] === "string" && params["repo"]) {
        runs = runs.filter((r) => r.repoFullName === params["repo"]);
      }
      sendResponse(ws, { jsonrpc: "2.0", id, result: runs });
      break;
    }

    case METHODS.GET_PR_DETAILS: {
      const params = req.params ?? {};
      const prId = params["id"];
      const prNumber = params["number"];
      const prRepo = params["repo"];
      let pr: PullRequest | undefined;
      if (typeof prId === "number") {
        pr = snapshot!.pullRequests.find((p) => p.id === prId);
      } else if (typeof prNumber === "number" && typeof prRepo === "string") {
        pr = snapshot!.pullRequests.find(
          (p) => p.number === prNumber && p.repoFullName === prRepo
        );
      }
      if (!pr) {
        sendResponse(ws, {
          jsonrpc: "2.0",
          id,
          error: { code: -32002, message: "PR not found" },
        });
      } else {
        sendResponse(ws, { jsonrpc: "2.0", id, result: pr });
      }
      break;
    }

    case METHODS.GET_RATE_LIMIT: {
      const core = getCoreRateLimit();
      const graphql = getGraphqlRateLimit();
      if (!core && !graphql) {
        sendResponse(ws, {
          jsonrpc: "2.0",
          id,
          error: { code: -32002, message: "Rate limit data not yet available" },
        });
      } else {
        sendResponse(ws, {
          jsonrpc: "2.0",
          id,
          result: {
            core: core
              ? { limit: core.limit, remaining: core.remaining, resetAt: core.resetAt.toISOString() }
              : null,
            graphql: graphql
              ? { limit: graphql.limit, remaining: graphql.remaining, resetAt: graphql.resetAt.toISOString() }
              : null,
          },
        });
      }
      break;
    }

    case METHODS.GET_CONFIG: {
      sendResponse(ws, {
        jsonrpc: "2.0",
        id,
        result: {
          selectedRepos: config.selectedRepos,
          trackedUsers: config.trackedUsers,
          upstreamRepos: config.upstreamRepos,
          monitoredRepos: config.monitoredRepos,
        },
      });
      break;
    }

    case METHODS.GET_REPOS: {
      sendResponse(ws, { jsonrpc: "2.0", id, result: config.selectedRepos });
      break;
    }

    default: {
      sendResponse(ws, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      });
      break;
    }
  }
}

export function connectRelay(port: number): void {
  // Close existing connection before opening a new one
  if (_ws) {
    _ws.onopen = null;
    _ws.onmessage = null;
    _ws.onclose = null;
    _ws.onerror = null;
    _ws.close();
    _ws = null;
  }

  _deliberateDisconnect = false;
  _setRelayStatus("connecting");

  let ws: WebSocket;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch (err) {
    console.warn("[mcp-relay] WebSocket construction failed:", err);
    _setRelayStatus("disconnected");
    scheduleReconnect(port);
    return;
  }
  _ws = ws;

  ws.onopen = () => {
    _backoffIndex = 0;
    _setRelayStatus("connected");
    sendConfigUpdate(ws);
  };

  ws.onmessage = (event: MessageEvent) => {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(event.data as string) as JsonRpcRequest;
    } catch {
      console.warn("[mcp-relay] Failed to parse incoming message");
      return;
    }
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") return;
    handleRequest(ws, req);
  };

  ws.onclose = () => {
    if (_ws === ws) {
      _ws = null;
      _setRelayStatus("disconnected");
    }
    if (!_deliberateDisconnect) {
      scheduleReconnect(port);
    }
  };

  ws.onerror = () => {
    // onclose fires after onerror — let onclose handle reconnect logic
    console.warn("[mcp-relay] WebSocket error");
  };
}

function scheduleReconnect(port: number): void {
  clearBackoffTimer();
  const delay = BACKOFF_MS[Math.min(_backoffIndex, BACKOFF_MS.length - 1)];
  _backoffIndex = Math.min(_backoffIndex + 1, BACKOFF_MS.length - 1);
  _backoffTimer = setTimeout(() => {
    _backoffTimer = null;
    if (!_deliberateDisconnect && config.mcpRelayEnabled) {
      connectRelay(port);
    }
  }, delay);
}

export function disconnectRelay(): void {
  _deliberateDisconnect = true;
  clearBackoffTimer();
  if (_ws) {
    _ws.onopen = null;
    _ws.onmessage = null;
    _ws.onclose = null;
    _ws.onerror = null;
    _ws.close();
    _ws = null;
  }
  _setRelayStatus("disconnected");
}

// ── Cleanup on page unload ─────────────────────────────────────────────────────

window.addEventListener("pagehide", () => disconnectRelay());
window.addEventListener("beforeunload", () => disconnectRelay());

// ── Init ──────────────────────────────────────────────────────────────────────

let _initialized = false;

export function initMcpRelay(): void {
  if (_initialized) return;
  _initialized = true;

  // Watch mcpRelayEnabled — connect when true, disconnect when false
  createEffect(() => {
    const enabled = config.mcpRelayEnabled;
    const port = config.mcpRelayPort;
    if (enabled) {
      connectRelay(port);
    } else {
      disconnectRelay();
    }
  });

  // Send config_update whenever relevant config fields change while connected
  createEffect(() => {
    // Track the fields we care about
    const _selectedRepos = config.selectedRepos;
    const _trackedUsers = config.trackedUsers;
    const _upstreamRepos = config.upstreamRepos;
    const _monitoredRepos = config.monitoredRepos;
    // Suppress lint warning — these reads establish reactive tracking
    void _selectedRepos;
    void _trackedUsers;
    void _upstreamRepos;
    void _monitoredRepos;

    if (_ws && _ws.readyState === WebSocket.OPEN) {
      sendConfigUpdate(_ws);
    }
  });
}

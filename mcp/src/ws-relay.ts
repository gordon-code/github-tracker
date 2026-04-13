// ── WebSocket relay server ────────────────────────────────────────────────────
// Listens on 127.0.0.1:PORT for a single WebSocket connection from the SPA.
// Uses JSON-RPC 2.0 for request/response and notification dispatch.
//
// Security controls:
//   - Origin validation
//   - maxPayload: 10 MiB
//   - try/catch around JSON.parse

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";

// ── Configuration ─────────────────────────────────────────────────────────────

const DEFAULT_PORT = 9876;
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024; // 10 MiB

// ── State ─────────────────────────────────────────────────────────────────────

let _wss: WebSocketServer | null = null;
let _client: WebSocket | null = null;
let _isAlive = false;
let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
// Store handle so stopHeartbeat() can cancel a pending pong-timeout
let _pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
let _idCounter = 0;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const _pending = new Map<number, PendingRequest>();
const _notificationHandlers = new Map<string, ((params: unknown) => void)[]>();

// ── Origin validation ─────────────────────────────────────────────────────────

const ALLOWED_ORIGINS_DEFAULT = new Set([
  "http://localhost",
  "https://localhost",
  "http://127.0.0.1",
  "https://127.0.0.1",
]);

function buildAllowedOrigins(): Set<string> {
  const extra = process.env.MCP_RELAY_ALLOWED_ORIGINS;
  if (!extra) return ALLOWED_ORIGINS_DEFAULT;
  const combined = new Set(ALLOWED_ORIGINS_DEFAULT);
  for (const o of extra.split(",")) {
    const trimmed = o.trim();
    if (trimmed) combined.add(trimmed);
  }
  return combined;
}

// Computed once at module scope — origins don't change at runtime
const ALLOWED_ORIGINS = buildAllowedOrigins();

// Warn if only localhost origins are configured — production domains need MCP_RELAY_ALLOWED_ORIGINS
if (!process.env.MCP_RELAY_ALLOWED_ORIGINS) {
  console.error("[mcp/ws] Warning: No MCP_RELAY_ALLOWED_ORIGINS set — only localhost connections allowed. Set this to your production domain to allow WebSocket relay from the deployed SPA.");
}

function isOriginAllowed(origin: string | undefined): boolean {
  // Non-browser clients (e.g. CLI tools) do not send Origin — allow them.
  if (origin === undefined) return true;

  if (ALLOWED_ORIGINS.has(origin)) return true;

  // Allow any localhost/127.0.0.1 origin with any port
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
  } catch {
    // Not a valid URL — reject
  }
  return false;
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

function startHeartbeat(): void {
  if (_heartbeatTimer) clearInterval(_heartbeatTimer);
  _heartbeatTimer = setInterval(() => {
    const client = _client;
    if (!client || client.readyState !== WebSocket.OPEN) return;

    if (!_isAlive) {
      console.error("[mcp/ws] Client stalled (no pong received). Terminating.");
      client.terminate();
      return;
    }
    _isAlive = false;
    client.ping();

    if (_pongTimeoutTimer !== null) clearTimeout(_pongTimeoutTimer);
    _pongTimeoutTimer = setTimeout(() => {
      _pongTimeoutTimer = null;
      if (!_isAlive && _client === client && client.readyState === WebSocket.OPEN) {
        console.error("[mcp/ws] Pong timeout. Terminating stalled client.");
        client.terminate();
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
  if (_pongTimeoutTimer !== null) {
    clearTimeout(_pongTimeoutTimer);
    _pongTimeoutTimer = null;
  }
}

// ── Pending request cleanup ───────────────────────────────────────────────────

function rejectAllPending(reason: string): void {
  for (const [id, pending] of _pending) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    _pending.delete(id);
  }
}

// ── Message handling ──────────────────────────────────────────────────────────

function handleMessage(rawData: Buffer | string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(rawData.toString()) as Record<string, unknown>;
  } catch {
    console.error("[mcp/ws] Received invalid JSON — ignoring.");
    return;
  }

  if (msg.jsonrpc !== "2.0") {
    console.error("[mcp/ws] Non-JSON-RPC message — ignoring.");
    return;
  }

  // Response to a pending request (has id, no method)
  if ("id" in msg && !("method" in msg)) {
    const id = msg.id as number;
    const pending = _pending.get(id);
    if (!pending) return;

    clearTimeout(pending.timer);
    _pending.delete(id);

    if ("error" in msg) {
      pending.reject(new Error(String((msg.error as { message?: string })?.message ?? msg.error)));
    } else {
      pending.resolve(msg.result);
    }
    return;
  }

  // Notification (has method, no id)
  if ("method" in msg && !("id" in msg)) {
    const method = msg.method as string;
    const params = msg.params ?? {};
    const handlers = _notificationHandlers.get(method);
    if (handlers) {
      for (const h of handlers) {
        try {
          h(params);
        } catch (err) {
          console.error(`[mcp/ws] Notification handler error for ${method}:`, err instanceof Error ? err.message : String(err));
        }
      }
    }
    return;
  }

  console.error("[mcp/ws] Unrecognized message shape — ignoring.");
}

// ── Public API ────────────────────────────────────────────────────────────────

export function isRelayConnected(): boolean {
  return _client !== null && _client.readyState === WebSocket.OPEN;
}

export function sendRelayRequest(method: string, params: unknown): Promise<unknown> {
  if (!isRelayConnected()) {
    return Promise.reject(new Error("[mcp/ws] Relay not connected."));
  }

  const id = ++_idCounter;
  const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending.delete(id);
      reject(new Error(`[mcp/ws] Request timed out: ${method} (id=${id})`));
    }, REQUEST_TIMEOUT_MS);

    _pending.set(id, { resolve, reject, timer });

    try {
      _client!.send(message);
    } catch (err) {
      clearTimeout(timer);
      _pending.delete(id);
      reject(err);
    }
  });
}

export function onNotification(method: string, handler: (params: unknown) => void): void {
  const handlers = _notificationHandlers.get(method) ?? [];
  handlers.push(handler);
  _notificationHandlers.set(method, handlers);
}

export function startWebSocketServer(): WebSocketServer | null {
  const port = parseInt(process.env.MCP_WS_PORT ?? String(DEFAULT_PORT), 10);

  function verifyClient(
    info: { origin: string; req: IncomingMessage; secure: boolean },
    callback: (res: boolean, code?: number, message?: string) => void
  ): void {
    const origin = info.req.headers.origin as string | undefined;
    if (!isOriginAllowed(origin)) {
      console.error(`[mcp/ws] Rejected connection from disallowed origin: ${origin ?? "(none)"}`);
      callback(false, 403, "Origin not allowed");
      return;
    }
    if (_client && _client.readyState === WebSocket.OPEN) {
      console.error("[mcp/ws] Rejected second connection attempt (code 4001).");
      callback(false, 4001, "Only one client allowed");
      return;
    }
    callback(true);
  }

  try {
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port,
      maxPayload: MAX_PAYLOAD_BYTES,
      verifyClient,
    });

    wss.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[mcp/ws] Port ${port} already in use — continuing without WebSocket relay.`);
      } else {
        console.error("[mcp/ws] WebSocket server error:", err.message);
      }
    });

    wss.on("connection", (ws: WebSocket) => {
      console.error(`[mcp/ws] SPA connected on ws://127.0.0.1:${port}`);
      _client = ws;
      _isAlive = true;

      ws.on("pong", () => {
        _isAlive = true;
      });

      ws.on("message", (data: Buffer | string) => {
        handleMessage(data);
      });

      ws.on("close", () => {
        console.error("[mcp/ws] SPA disconnected.");
        rejectAllPending("WebSocket relay disconnected");
        _client = null;
        stopHeartbeat();
      });

      ws.on("error", (err: Error) => {
        console.error("[mcp/ws] Client WebSocket error:", err.message);
      });

      startHeartbeat();
    });

    wss.on("listening", () => {
      console.error(`[mcp/ws] WebSocket relay listening on ws://127.0.0.1:${port}`);
    });

    _wss = wss;
    return wss;
  } catch (err) {
    console.error("[mcp/ws] Failed to create WebSocket server:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

export function closeWebSocketServer(): Promise<void> {
  return new Promise((resolve) => {
    stopHeartbeat();
    rejectAllPending("WebSocket relay shutting down");

    if (_client) {
      _client.terminate();
      _client = null;
    }

    if (_wss) {
      _wss.close(() => resolve());
      _wss = null;
    } else {
      resolve();
    }
  });
}

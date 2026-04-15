// ── WebSocket relay server unit tests ─────────────────────────────────────────
// Tests the ws-relay server behavior using the real `ws` library.
// Each test group starts a fresh server on port 0 (OS-assigned port).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import {
  startWebSocketServer,
  closeWebSocketServer,
  isRelayConnected,
  sendRelayRequest,
  onNotification,
} from "../src/ws-relay.js";
import type { WebSocketServer } from "ws";

// ── Helpers ────────────────────────────────────────────────────────────────────

function getServerPort(wss: WebSocketServer): number {
  const addr = wss.address();
  if (addr && typeof addr === "object") return addr.port;
  throw new Error("Server has no address — may not be listening yet");
}

function waitForEvent(emitter: { on: (event: string, cb: (...args: unknown[]) => void) => void }, event: string, timeout = 2000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeout);
    emitter.on(event, (...args: unknown[]) => {
      clearTimeout(t);
      resolve(args);
    });
  });
}

function waitForOpen(ws: WebSocket, timeout = 2000): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Timeout waiting for WebSocket open")), timeout);
    ws.once("open", () => { clearTimeout(t); resolve(); });
    ws.once("error", (err) => { clearTimeout(t); reject(err); });
  });
}

function waitForMessage(ws: WebSocket, timeout = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Timeout waiting for message")), timeout);
    ws.once("message", (data) => {
      clearTimeout(t);
      resolve(data.toString());
    });
  });
}

function waitForClose(ws: WebSocket, timeout = 2000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve({ code: 1000, reason: "" });
      return;
    }
    const t = setTimeout(() => reject(new Error("Timeout waiting for WebSocket close")), timeout);
    ws.once("close", (code, reason) => {
      clearTimeout(t);
      resolve({ code, reason: reason.toString() });
    });
  });
}

function sendJsonRpc(ws: WebSocket, msg: object): void {
  ws.send(JSON.stringify(msg));
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
 * Round-trip sentinel: sends a relay request from the server to the client and
 * waits for the client to respond.  By the time this resolves, the server has
 * processed every message that was sent before the sentinel was issued.
 */
async function roundTripSentinel(ws: WebSocket): Promise<void> {
  const sentinelPromise = sendRelayRequest("__sentinel__", {});
  const raw = await waitForMessage(ws);
  const msg = JSON.parse(raw) as { id: number };
  // Respond so the pending request resolves cleanly
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null }));
  await sentinelPromise;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("WebSocket relay server — connection", () => {
  let wss: WebSocketServer;
  let port: number;
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    process.env.MCP_WS_PORT = "0";
    wss = startWebSocketServer()!;
    expect(wss).not.toBeNull();
    await waitForEvent(wss, "listening");
    port = getServerPort(wss);
  });

  afterEach(async () => {
    for (const c of clients) {
      if (c.readyState === WebSocket.OPEN || c.readyState === WebSocket.CONNECTING) {
        c.close();
      }
    }
    clients.length = 0;
    await closeWebSocketServer();
    delete process.env.MCP_WS_PORT;
    vi.restoreAllMocks();
  });

  it("accepts a single client connection", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    clients.push(ws);
    await waitForOpen(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(isRelayConnected()).toBe(true);
  });

  it("rejects a second client (only one client allowed)", async () => {
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}`);
    clients.push(ws1);
    await waitForOpen(ws1);

    // ws library: when verifyClient rejects with code 4001, it sends an HTTP response
    // with that status code. Code 4001 is not a valid HTTP status, so the client sees
    // either an HPE_INVALID_STATUS parse error or a close event. We just verify
    // the second client never reaches OPEN state.
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
    clients.push(ws2);

    const rejected = await new Promise<boolean>((resolve) => {
      ws2.once("open", () => resolve(false)); // Should not open
      ws2.once("error", () => resolve(true)); // Error = rejected
      ws2.once("close", (code) => {
        // Any close (including 4001) counts as rejected
        resolve(code !== 1000 || ws2.readyState === WebSocket.CLOSED);
      });
      // Safety timeout
      setTimeout(() => resolve(true), 2000);
    });

    expect(rejected).toBe(true);
    expect(ws1.readyState).toBe(WebSocket.OPEN); // First client still open
  });

  it("reports disconnected after client closes", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    clients.push(ws);
    await waitForOpen(ws);
    expect(isRelayConnected()).toBe(true);

    ws.close();
    await waitForClose(ws);

    // Wait for the server's close handler to set _client = null
    await waitForCondition(() => !isRelayConnected());
    expect(isRelayConnected()).toBe(false);
  });

  it("handles malformed JSON without crashing", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    clients.push(ws);
    await waitForOpen(ws);

    // Send garbage — server should ignore it gracefully
    ws.send("this is not valid json{{{{");

    // Round-trip sentinel: proves server processed the malformed message and is still alive
    await roundTripSentinel(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(isRelayConnected()).toBe(true);
  });

  it("ignores non-JSON-RPC 2.0 messages", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    clients.push(ws);
    await waitForOpen(ws);

    // Valid JSON but wrong jsonrpc version
    ws.send(JSON.stringify({ jsonrpc: "1.0", id: 1, method: "test" }));

    // Round-trip sentinel: proves server processed the invalid message and is still alive
    await roundTripSentinel(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe("WebSocket relay server — JSON-RPC request/response", () => {
  let wss: WebSocketServer;
  let port: number;
  let client: WebSocket;

  beforeEach(async () => {
    process.env.MCP_WS_PORT = "0";
    wss = startWebSocketServer()!;
    await waitForEvent(wss, "listening");
    port = getServerPort(wss);
    client = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(client);
  });

  afterEach(async () => {
    if (client.readyState === WebSocket.OPEN) client.close();
    await closeWebSocketServer();
    delete process.env.MCP_WS_PORT;
    vi.restoreAllMocks();
  });

  it("resolves sendRelayRequest when client sends a response", async () => {
    // sendRelayRequest sends a JSON-RPC request to the client; client sends back a response
    const requestPromise = sendRelayRequest("test_method", { foo: "bar" });

    // Read what the server sent us
    const rawRequest = await waitForMessage(client);
    const req = JSON.parse(rawRequest) as { jsonrpc: string; id: number; method: string; params: unknown };
    expect(req.jsonrpc).toBe("2.0");
    expect(req.method).toBe("test_method");
    expect(req.params).toEqual({ foo: "bar" });

    // Send back a JSON-RPC response
    sendJsonRpc(client, { jsonrpc: "2.0", id: req.id, result: { answer: 42 } });

    const result = await requestPromise;
    expect(result).toEqual({ answer: 42 });
  });

  it("rejects sendRelayRequest when client sends an error response", async () => {
    const requestPromise = sendRelayRequest("broken_method", {});

    const rawRequest = await waitForMessage(client);
    const req = JSON.parse(rawRequest) as { id: number };

    sendJsonRpc(client, {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: "Method not found" },
    });

    await expect(requestPromise).rejects.toThrow("Method not found");
  });

  it("rejects pending requests when client disconnects", async () => {
    const requestPromise = sendRelayRequest("slow_method", {});
    // Attach catch immediately to prevent unhandled rejection
    requestPromise.catch(() => {});

    // Consume the request message so it doesn't block
    await waitForMessage(client);

    // Close client without responding
    client.close();
    await waitForClose(client);

    // Wait for the server's close handler to reject pending requests and clear _client
    await waitForCondition(() => !isRelayConnected());

    await expect(requestPromise).rejects.toThrow(/relay disconnected|disconnected/i);
  });
});

describe("WebSocket relay server — pending request timeout", () => {
  let wss: WebSocketServer;
  let port: number;
  let client: WebSocket;

  beforeEach(async () => {
    process.env.MCP_WS_PORT = "0";
    wss = startWebSocketServer()!;
    await waitForEvent(wss, "listening");
    port = getServerPort(wss);
    client = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(client);
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (client?.readyState === WebSocket.OPEN) client.close();
    await closeWebSocketServer();
    delete process.env.MCP_WS_PORT;
    vi.restoreAllMocks();
  });

  it("rejects pending request after REQUEST_TIMEOUT_MS (10s)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Start a request — server sends to client, client doesn't respond
    const requestPromise = sendRelayRequest("timeout_method", {});
    // Prevent unhandled rejection
    requestPromise.catch(() => {});

    // Read but don't respond to the request (consume the message)
    await new Promise<void>((resolve) => {
      client.once("message", () => resolve());
    });

    // Advance time past the 10s timeout
    vi.advanceTimersByTime(11000);
    await vi.runAllTimersAsync();

    await expect(requestPromise).rejects.toThrow(/timed out/i);
  });
});

describe("WebSocket relay server — notifications", () => {
  let wss: WebSocketServer;
  let port: number;
  let client: WebSocket;

  beforeEach(async () => {
    process.env.MCP_WS_PORT = "0";
    wss = startWebSocketServer()!;
    await waitForEvent(wss, "listening");
    port = getServerPort(wss);
    client = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(client);
  });

  afterEach(async () => {
    if (client.readyState === WebSocket.OPEN) client.close();
    await closeWebSocketServer();
    delete process.env.MCP_WS_PORT;
    vi.restoreAllMocks();
  });

  it("dispatches notifications to registered handlers", async () => {
    const handler = vi.fn();
    const handlerCalled = new Promise<void>((resolve) => {
      onNotification("test_notification", (params) => {
        handler(params);
        resolve();
      });
    });

    // Client sends a notification (no id field)
    sendJsonRpc(client, {
      jsonrpc: "2.0",
      method: "test_notification",
      params: { key: "value" },
    });

    // Wait for the notification handler to be invoked
    await handlerCalled;
    expect(handler).toHaveBeenCalledWith({ key: "value" });
  });

  it("ignores messages with unknown shape (both id and method present)", async () => {
    // A request from the client to the server is not part of the protocol
    // Server should ignore it gracefully
    sendJsonRpc(client, {
      jsonrpc: "2.0",
      id: 1,
      method: "some_method",
      params: {},
    });

    // Round-trip sentinel: proves server processed the unrecognized message and is still alive
    await roundTripSentinel(client);
    // No error — server still alive
    expect(isRelayConnected()).toBe(true);
  });
});

describe("WebSocket relay server — origin validation", () => {
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    process.env.MCP_WS_PORT = "0";
    wss = startWebSocketServer()!;
    await waitForEvent(wss, "listening");
    port = getServerPort(wss);
  });

  afterEach(async () => {
    await closeWebSocketServer();
    delete process.env.MCP_WS_PORT;
    vi.restoreAllMocks();
  });

  it("allows connections from localhost origins", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { origin: "http://localhost:5173" },
    });

    const opened = await new Promise<boolean>((resolve) => {
      ws.once("open", () => { ws.close(); resolve(true); });
      ws.once("error", () => resolve(false));
      ws.once("close", (code) => {
        // 4001 means rejected for second client, other non-1000 means rejected by server
        if (code !== 1000 && code !== 1001) resolve(false);
      });
    });

    expect(opened).toBe(true);
  });

  it("allows connections from the production domain", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { origin: "https://gh.gordoncode.dev" },
    });

    const opened = await new Promise<boolean>((resolve) => {
      ws.once("open", () => { ws.close(); resolve(true); });
      ws.once("error", () => resolve(false));
      ws.once("close", (code) => {
        if (code !== 1000 && code !== 1001) resolve(false);
      });
    });

    expect(opened).toBe(true);
  });

  it("rejects connections from disallowed origins", async () => {
    // The server calls verifyClient with callback(false, 403, "Origin not allowed").
    // The ws library sends an HTTP 403 response, which the client sees as an error.
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { origin: "https://evil.example.com" },
    });

    const rejected = await new Promise<boolean>((resolve) => {
      ws.once("open", () => { ws.close(); resolve(false); }); // Should not open
      ws.once("error", () => resolve(true)); // Error = rejected by server
      ws.once("close", () => resolve(true)); // Close = connection refused
      setTimeout(() => resolve(true), 2000); // Safety timeout
    });

    expect(rejected).toBe(true);
  });
});

describe("sendRelayRequest — disconnected state", () => {
  afterEach(async () => {
    await closeWebSocketServer();
    vi.restoreAllMocks();
  });

  it("rejects immediately when relay is not connected", async () => {
    // No server started — relay is not connected
    await expect(sendRelayRequest("any_method", {})).rejects.toThrow(
      /relay not connected/i
    );
  });
});

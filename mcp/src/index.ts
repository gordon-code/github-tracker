// FIX-008: All imports are at the top of the file.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getOptionalOctokitClient, validateTokenScopes } from "./octokit.js";
import {
  OctokitDataSource,
  WebSocketDataSource,
  CompositeDataSource,
  setCachedConfig,
} from "./data-source.js";
import type { DataSource } from "./data-source.js";
import type { DashboardSummary, Issue, PullRequest, RateLimitInfo, RepoRef, WorkflowRun } from "../../src/shared/types.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import { startWebSocketServer, closeWebSocketServer, onNotification } from "./ws-relay.js";
import { NOTIFICATIONS } from "../../src/shared/protocol.js";
import { RepoRefSchema, TrackedUserSchema } from "../../src/shared/schemas.js";

// ── Server setup ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "github-tracker",
  version: "0.1.0",
});

// ── Config update validation schemas ──────────────────────────────────────────
// SEC-001: Validate config_update payloads with Zod

const MAX_REPOS = 200;
const MAX_TRACKED_USERS = 10;
const MAX_MONITORED_REPOS = 10;

const ConfigUpdatePayloadSchema = z.object({
  selectedRepos: RepoRefSchema.array().max(MAX_REPOS).default([]),
  trackedUsers: TrackedUserSchema.array().max(MAX_TRACKED_USERS).default([]),
  upstreamRepos: RepoRefSchema.array().max(MAX_REPOS).default([]),
  monitoredRepos: RepoRefSchema.array().max(MAX_MONITORED_REPOS).default([]),
});

// ── Main entry point ──────────────────────────────────────────────────────────

async function main() {
  // Start WebSocket relay before MCP transport
  const wss = startWebSocketServer();

  // Wire config_update notification with Zod validation (SEC-001)
  onNotification(NOTIFICATIONS.CONFIG_UPDATE, (params) => {
    const result = ConfigUpdatePayloadSchema.safeParse(params);
    if (!result.success) {
      console.error(
        "[mcp] config_update payload failed validation:",
        result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      );
      return;
    }
    setCachedConfig(result.data);
    console.error(
      `[mcp] Config updated: ${result.data.selectedRepos.length} repos, ` +
        `${result.data.trackedUsers.length} tracked users`
    );
  });

  // Build data source (WebSocket + Octokit composite)
  const octokitClient = getOptionalOctokitClient();
  const octokitDs = octokitClient
    ? new OctokitDataSource(octokitClient)
    : null;
  const wsDs = new WebSocketDataSource();

  // If no Octokit client, create a minimal fallback that always errors
  const effectiveOctokitDs = octokitDs ?? createUnavailableDataSource();
  const dataSource = new CompositeDataSource(wsDs, effectiveOctokitDs);

  // Register tools and resources
  registerTools(server, dataSource);
  registerResources(server, dataSource);

  // Validate token scopes (logs to stderr)
  await validateTokenScopes();

  // Connect MCP stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] GitHub Tracker MCP server started");

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    console.error(`[mcp] Received ${signal}, shutting down...`);
    await closeWebSocketServer();
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Log WebSocket address
  if (wss) {
    const port = process.env.MCP_WS_PORT ?? "9876";
    console.error(`[mcp] WebSocket relay available at ws://127.0.0.1:${port}`);
  }
}

// ── Unavailable data source stub ──────────────────────────────────────────────
// Used when no GITHUB_TOKEN is set — all methods throw a clear error.

function createUnavailableDataSource(): DataSource {
  const err = () => Promise.reject(new Error(
    "No GITHUB_TOKEN set and SPA relay is not connected. " +
      "Set GITHUB_TOKEN or open the dashboard to enable data access."
  ));
  return {
    getDashboardSummary: (): Promise<DashboardSummary> => err(),
    getOpenPRs: (): Promise<PullRequest[]> => err(),
    getOpenIssues: (): Promise<Issue[]> => err(),
    getFailingActions: (): Promise<WorkflowRun[]> => err(),
    getPRDetails: (): Promise<PullRequest | null> => err(),
    getRateLimit: (): Promise<RateLimitInfo> => err(),
    getConfig: (): Promise<object | null> => Promise.resolve(null),
    getRepos: (): Promise<RepoRef[]> => Promise.resolve([]),
  };
}

main().catch((error) => {
  console.error("[mcp] Failed to start MCP server:", error);
  process.exit(1);
});

// ── MCP resource registration ─────────────────────────────────────────────────
// Registers tracker:// resources with the MCP server.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DataSource } from "./data-source.js";

// ── Resource registration ─────────────────────────────────────────────────────

export function registerResources(server: McpServer, dataSource: DataSource): void {
  // 1. tracker://config — Current tracked repos/users configuration
  server.registerResource(
    "tracker-config",
    "tracker://config",
    {
      description: "Current tracked repos, users, and configuration for the GitHub Tracker",
      mimeType: "application/json",
    },
    async (_uri) => {
      const config = await dataSource.getConfig();
      const text = config !== null
        ? JSON.stringify(config, null, 2)
        : JSON.stringify({ status: "No configuration available. Connect the SPA to sync config." }, null, 2);
      return {
        contents: [
          {
            uri: "tracker://config",
            mimeType: "application/json",
            text,
          },
        ],
      };
    }
  );

  // 2. tracker://repos — List of configured repositories
  server.registerResource(
    "tracker-repos",
    "tracker://repos",
    {
      description: "List of repositories currently tracked by the GitHub Tracker",
      mimeType: "application/json",
    },
    async (_uri) => {
      const repos = await dataSource.getRepos();
      const text = JSON.stringify(
        {
          count: repos.length,
          repos: repos.map((r) => ({
            fullName: r.fullName,
            owner: r.owner,
            name: r.name,
          })),
        },
        null,
        2
      );
      return {
        contents: [
          {
            uri: "tracker://repos",
            mimeType: "application/json",
            text,
          },
        ],
      };
    }
  );
}

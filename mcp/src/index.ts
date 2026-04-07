import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { validateTokenScopes } from "./octokit.js";

const server = new McpServer({
  name: "github-tracker",
  version: "0.1.0",
});

// Tools and resources registered in Task 3
// WebSocket relay initialized in Task 4

async function main() {
  await validateTokenScopes();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("GitHub Tracker MCP server started");
}

main().catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});

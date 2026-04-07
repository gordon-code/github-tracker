# github-tracker-mcp

MCP server for [GitHub Tracker](https://github.com/gordon-code/github-tracker) — exposes dashboard data (open PRs, issues, failing CI) to AI clients like Claude Code and Cursor.

## Install

```bash
# Run without installing
npx github-tracker-mcp

# Or install globally
npm install -g github-tracker-mcp
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_TOKEN` | Yes* | — | GitHub PAT or OAuth token. Fine-grained PATs with Contents (read) and Metadata (read) are sufficient. |
| `MCP_WS_PORT` | No | `9876` | WebSocket relay port for receiving live data from the dashboard SPA. |

*`GITHUB_TOKEN` is required for direct API mode. If the dashboard's WebSocket relay is connected, the server can serve data without it.

## Claude Code setup

Add to `~/.claude.json` (global) or `.claude/settings.json` (project):

```json
{
  "mcpServers": {
    "github-tracker": {
      "command": "npx",
      "args": ["-y", "github-tracker-mcp"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  }
}
```

> Don't commit `GITHUB_TOKEN` to source control. Use environment variables or a secrets manager.

## Available tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_dashboard_summary` | Aggregated counts of open PRs, issues, failing CI | `scope` (involves_me\|all) |
| `get_open_prs` | Open PRs with check status and review decision | `repo?`, `status?` (all\|needs_review\|failing\|approved\|draft) |
| `get_open_issues` | Open issues across tracked repos | `repo?` |
| `get_failing_actions` | In-progress or recently failed workflow runs | `repo?` |
| `get_pr_details` | Detailed info about a specific PR | `repo`, `number` |
| `get_rate_limit` | Current GitHub API rate limit status | — |

## Resources

- `tracker://config` — current dashboard configuration (selected repos, tracked users)
- `tracker://repos` — list of tracked repositories

## WebSocket relay

Enable the WebSocket relay in the dashboard's Settings page to let the MCP server receive live data directly from the SPA. When connected, the server prefers relay data and falls back to direct GitHub API calls. This reduces API usage and gives the AI client real-time data without polling.

The relay listens on `ws://127.0.0.1:9876` by default. Override with `MCP_WS_PORT`.

## Full documentation

See the [GitHub Tracker repository](https://github.com/gordon-code/github-tracker) for deployment, contributing, and architecture details.

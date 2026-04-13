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
| `GITHUB_TOKEN` | No | — | Classic PAT with `repo` and `read:org` scopes (recommended), or fine-grained PAT with Actions (read), Contents (read), Issues (read), and Pull requests (read) permissions. Fine-grained PATs skip scope validation at startup. |
| `MCP_WS_PORT` | No | `9876` | WebSocket relay port for receiving live data from the dashboard SPA. |
| `MCP_RELAY_ALLOWED_ORIGINS` | No | — | Comma-separated additional origins for WebSocket connections (e.g., `https://your-domain.example.com`). Localhost origins are always allowed. |

`GITHUB_TOKEN` is required for standalone (direct API) mode. In relay mode the server receives data from the dashboard and works without a token. If you set `GITHUB_TOKEN` alongside the relay, the server uses it as a fallback when the relay disconnects.

## Claude Code setup

```bash
claude mcp add --transport stdio --env GITHUB_TOKEN=ghp_... github-tracker -- npx -y github-tracker-mcp@latest
```

Or add `--scope project` to store in `.mcp.json` (shared with git — don't include real tokens in committed files).

## Available tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_dashboard_summary` | Aggregated counts of open PRs, issues, failing CI, PRs needing review, approved but unmerged | `scope?` (involves_me\|all, default: involves_me) |
| `get_open_prs` | Open PRs with check status and review decision | `repo?`, `status?` (all\|needs_review\|failing\|approved\|draft) |
| `get_open_issues` | Open issues across tracked repos | `repo?` |
| `get_failing_actions` | In-progress or recently failed workflow runs | `repo?` |
| `get_pr_details` | Detailed info about a specific PR | `repo`, `number` |
| `get_rate_limit` | Current GitHub API rate limit status | — |

`repo` parameters use `owner/repo` format (e.g., `octocat/hello-world`).

## Resources

- `tracker://config` — current dashboard configuration (selected repos, tracked users)
- `tracker://repos` — list of tracked repositories

## WebSocket relay

Enable the WebSocket relay in the dashboard's Settings page to let the MCP server receive live data directly from the SPA. When connected, the server prefers relay data and falls back to direct GitHub API calls. This reduces API usage and gives the AI client the same enriched data visible in the dashboard without separate polling.

The relay listens on `ws://127.0.0.1:9876` by default. Override with `MCP_WS_PORT`.

### Direct API mode limitations

Without the relay, the MCP server uses REST search which lacks some GraphQL-sourced fields. This affects:

- `get_open_prs` — `status=failing` and `status=approved` filters return empty results (REST search lacks check status and review decision data). `status=needs_review` works correctly via the `review-requested:` search qualifier.
- `get_dashboard_summary` — `approvedUnmergedCount` is always 0; `scope` parameter works as expected
- `get_dashboard_summary` — when the relay IS connected, `scope` is ignored (the relay always reflects the dashboard's current data set)

For full filter accuracy for `failing` and `approved` statuses, use the WebSocket relay.

## Full documentation

See the [GitHub Tracker repository](https://github.com/gordon-code/github-tracker) for deployment, contributing, and architecture details.

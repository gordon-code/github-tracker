# GitHub Tracker User Guide

GitHub Tracker is a dashboard that aggregates open issues, pull requests, and GitHub Actions workflow runs across your repositories into a single view at [gh.gordoncode.dev](https://gh.gordoncode.dev).

## Table of Contents

- [Getting Started](#getting-started)
  - [OAuth Sign-In](#oauth-sign-in)
  - [Personal Access Token Sign-In](#personal-access-token-sign-in)
  - [Repository Selection](#repository-selection)
  - [Organization Access](#organization-access)
- [Dashboard Overview](#dashboard-overview)
  - [Tab Structure](#tab-structure)
  - [Custom Tabs](#custom-tabs)
  - [Personal Summary Strip](#personal-summary-strip)
  - [Repo Grouping and Expand/Collapse](#repo-grouping-and-expandcollapse)
  - [Scope Filter](#scope-filter)
- [Issues Tab](#issues-tab)
  - [Filters](#issues-filters)
  - [Dependency Dashboard Toggle](#dependency-dashboard-toggle)
  - [Sorting](#issues-sorting)
  - [Ignored Items](#ignored-items)
- [Pull Requests Tab](#pull-requests-tab)
  - [Status Indicators](#status-indicators)
  - [Filters](#pull-requests-filters)
  - [Sorting](#pull-requests-sorting)
- [Actions Tab](#actions-tab)
  - [Workflow Grouping](#workflow-grouping)
  - [Show PR Runs](#show-pr-runs)
  - [Filters](#actions-filters)
- [Multi-User Tracking](#multi-user-tracking)
- [Monitor-All Mode](#monitor-all-mode)
- [Upstream Repos](#upstream-repos)
- [Refresh and Polling](#refresh-and-polling)
- [Notifications](#notifications)
- [Tracked Items](#tracked-items)
- [Repo Pinning](#repo-pinning)
- [MCP Server Integration](#mcp-server-integration)
- [Settings Reference](#settings-reference)
- [Troubleshooting](#troubleshooting)

---

## Getting Started

### OAuth Sign-In

OAuth is the recommended sign-in method. Click **Sign in with GitHub** on the login page and authorize the application. GitHub will redirect you back with a token that grants access to `repo`, `read:org`, and `notifications` scopes.

OAuth tokens work across all organizations you belong to and support the notifications optimization that reduces API usage in background tabs.

### Personal Access Token Sign-In

If you prefer not to use OAuth, you can sign in with a GitHub Personal Access Token (PAT). Click **Use a Personal Access Token** on the login page and paste your token.

Two token formats are accepted:

- **Classic tokens** (starts with `ghp_`) — recommended. Works across all organizations you belong to. Required scopes: `repo`, `read:org` (under admin:org), `notifications`.
- **Fine-grained tokens** (starts with `github_pat_`) — also work, but have limitations: they only access one organization at a time, do not support the `notifications` scope, and therefore cannot use the background-poll optimization. Required permissions: Actions (read), Contents (read), Issues (read), Pull requests (read).

The token is validated against the GitHub API before being stored. It is saved permanently in your browser's `localStorage` — you will not need to re-enter it on revisit.

### Repository Selection

After signing in, the onboarding wizard asks you to select repositories to track. Search by name or browse by organization. You can change your selection at any time in **Settings > Repositories**.

### Organization Access

OAuth sign-in uses your existing GitHub org memberships. If a private organization does not appear in the repo selector, click **Manage org access** in Settings to open GitHub's OAuth application settings and grant access to that organization. When you return to the tracker, it automatically syncs your updated org list.

---

## Dashboard Overview

### Tab Structure

The dashboard has three built-in tabs by default, with optional additional tabs:

| Tab | Contents |
|-----|----------|
| **Issues** | Open issues across your selected repos where you are the author, assignee, or mentioned |
| **Pull Requests** | Open PRs where you are the author, reviewer, or assignee |
| **Actions** | Recent workflow runs for your selected repos |
| **Tracked** | Manually pinned issues and PRs (opt-in via Settings) |
| **Custom tabs** | Named filtered views you define (up to 10, see [Custom Tabs](#custom-tabs)) |

The active tab is remembered across page loads by default. You can set a fixed default tab in Settings.

### Custom Tabs

Custom tabs let you create named, filtered views over the Issues, PRs, or Actions data. For example, you could create a "My PRs" tab showing only PRs you authored, or a "Needs review" tab scoped to a single org.

**Creating a tab:** Click the **+** button at the right end of the tab bar (desktop) or go to **Settings > Custom Tabs** (mobile or desktop). Each tab requires:

- **Name** — displayed in the tab bar
- **Base type** — Issues, Pull Requests, or Actions
- **Scope** (optional) — restrict to a specific org or repo
- **Filter presets** (optional) — pre-apply one or more filters (e.g., Role: Author, Checks: Failing). Filters use the same options as the corresponding built-in tab. The value `_self` in user-based filters resolves to your authenticated login at runtime.

**Exclusive toggle:** When enabled, items that match the custom tab's scope and filters are hidden from the standard Issues, Pull Requests, or Actions tab. They appear only in the custom tab. Items in the Tracked tab are never hidden by exclusivity.

**Managing tabs:** In **Settings > Custom Tabs** you can edit, reorder, and delete custom tabs. Up to 10 custom tabs are supported.

### Personal Summary Strip

A summary strip appears directly below the tab bar whenever there is actionable activity. It shows counts for:

- **Issues assigned** to you
- **PRs awaiting your review** (you are a requested reviewer and the PR needs review)
- **PRs ready to merge** (you are the author, checks pass, PR is approved or has no review requirement, not a draft)
- **PRs blocked** (you are the author, PR is not a draft, checks are failing or there is a merge conflict)
- **Actions running** (in-progress workflow runs, excluding ignored items)

Clicking any count switches to the relevant tab and applies filters that match what was counted. This lets you jump directly to the most important items.

Counts are computed across all repos regardless of any org or repo filter you have active on the tab.

### Repo Grouping and Expand/Collapse

Items are grouped by repository. Each repo group has a header row showing the repo name, item count, and a summary of statuses (check results, review decisions, role counts). Click a repo header to expand or collapse that group.

Use the **Expand all** / **Collapse all** buttons in the toolbar to expand or collapse all groups at once.

When a group is collapsed, a brief preview of any status change detected by the hot poll appears under the header for a few seconds before fading.

### Scope Filter

The **Scope** filter chip appears on the Issues and Pull Requests tabs when you have tracked users configured or monitor-all repos enabled. It has two options:

- **Involves me** (default) — shows items where you or any of your tracked users are involved (author, assignee, reviewer, or mentioned). For monitored repos, only items where you are the author, assignee, or reviewer are shown.
- **All activity** — shows every open item across your selected repos. Items involving you or your tracked users are highlighted with a colored left border.

The scope filter is hidden (and always set to "Involves me") when you have no tracked users and no monitor-all repos, because in that configuration all fetched data already involves you.

---

## Issues Tab

### Issues Filters

| Filter | Options | Default |
|--------|---------|---------|
| Scope | Involves me / All activity | Involves me |
| Role | All / Author / Assignee | All |
| Comments | All / Has comments / No comments | All |
| User | All / (tracked user logins) | All (shown when tracked users are configured) |

Filters can be combined. Click **Reset all** to clear all active filters at once.

### Dependency Dashboard Toggle

The **Show Dep Dashboard** button controls whether the Renovate "Dependency Dashboard" issue appears in the list. The Dependency Dashboard issue is hidden by default. This setting applies across all repos.

### Issues Sorting

Sort by: Repo, Title, Author, Comments, Created, Updated (default: Updated, descending).

### Ignored Items

Each issue row has an ignore button (visible on hover). Ignored items are hidden from the list. To restore ignored items, click the **Ignored** badge in the toolbar, which lists all currently ignored items with an option to unignore each one. Ignored items are automatically pruned after 30 days.

---

## Pull Requests Tab

### Status Indicators

Each PR row displays several indicators:

#### Check Status Dot

A small colored dot shows the aggregate CI status for the PR's latest commit:

| Color | Meaning |
|-------|---------|
| Green (solid) | All checks passed |
| Yellow (pulsing) | Checks in progress |
| Red (solid) | Checks failing |
| Yellow/faded (solid) | Checks blocked by merge conflict |
| Gray (solid) | No checks |

The dot links to the PR's checks page on GitHub.

#### Review Badges

| Badge | Meaning |
|-------|---------|
| Approved | At least one approving review, no blocking reviews |
| Changes requested | At least one reviewer requested changes |
| Needs review | Review has been requested but not yet submitted |
| Dismissed | Previously submitted review was dismissed |

#### Size Badges

PR size is computed from total lines changed (additions + deletions):

| Badge | Total lines changed |
|-------|---------------------|
| XS | Less than 10 |
| S | 10 to 99 |
| M | 100 to 499 |
| L | 500 to 999 |
| XL | 1,000 or more |

The size badge links to the PR's file diff on GitHub.

#### Role Badges

Shows your involvement in the PR: **Author**, **Reviewer**, **Assignee**, or **Involved** (for items in upstream repos where you have no direct role).

### Pull Requests Filters

| Filter | Options | Default |
|--------|---------|---------|
| Scope | Involves me / All activity | Involves me |
| Role | All / Author / Reviewer / Assignee | All |
| Review | All / Approved / Changes / Needs review / Mergeable | All |
| Status | All / Draft / Ready | All |
| Checks | All / Passing / Failing / Pending / Conflict / Blocked / No CI | All |
| Size | All / XS / S / M / L / XL | All |
| User | All / (tracked user logins) | All (shown when tracked users are configured) |

**Mergeable** in the Review filter matches PRs that are approved or have no review requirement (equivalent to "safe to merge from review standpoint").

**Blocked** in the Checks filter matches PRs with failing checks or a merge conflict.

### Pull Requests Sorting

Sort by: Repo, Title, Author, Checks, Review, Size, Created, Updated (default: Updated, descending).

---

## Actions Tab

### Workflow Grouping

Workflow runs are grouped first by repository, then by workflow name. Each workflow group shows its most recent runs up to the configured limit (default: 3 runs per workflow, up to 5 workflows per repo).

### Show PR Runs

By default, runs triggered by pull request events are hidden to reduce noise. Toggle **Show PR runs** to include them. This preference is saved across sessions.

### Actions Filters

| Filter | Options | Default |
|--------|---------|---------|
| Conclusion | All / Success / Failure / Cancelled / Running / Other | All |
| Event | All / Push / Pull request / Schedule / Workflow dispatch / Other | All |

---

## Multi-User Tracking

You can track another GitHub user's issues and PRs alongside your own. Go to **Settings > Tracked Users**, enter a GitHub username, and click **Add**. The app validates the username against the GitHub API before saving.

- Tracked user items appear in the same Issues and Pull Requests tabs, mixed with your own items.
- Each item shows small avatar badges indicating which tracked users it was surfaced by.
- When multiple users are tracked, a **User** filter chip appears on the Issues and Pull Requests tabs, letting you view activity for one user at a time.
- Both regular GitHub users and bot accounts (e.g., `renovate[bot]`) can be tracked. Bot accounts are labeled with a "Bot" badge in the Tracked Users section.

**API usage note:** Each tracked user adds one additional GraphQL search query per poll cycle. At 3 or more tracked users, a warning appears in Settings. The hard cap is 10 tracked users.

---

## Monitor-All Mode

Normally, the dashboard shows only issues and PRs that involve you (or a tracked user). Monitor-all mode shows every open issue and PR in a specific repo — regardless of whether anyone you track is involved.

**How to enable:** In **Settings > Repositories**, expand the repo panel. Each repo has an eye icon toggle. Enabling it adds the repo to the monitored list (maximum 10 monitored repos).

**Effect on display:** Repo groups for monitored repos show a **Monitoring all** badge in their header. In "Involves me" scope, monitored repo items are shown when you are the author, assignee, or reviewer; switch to "All activity" to see all monitored repo items. Monitored repo items bypass the User filter.

Upstream repos cannot be monitored (only selected repos are eligible).

---

## Upstream Repos

Upstream repos are repositories that you contribute to but do not own — for example, open-source projects you have pull requests in.

**Auto-discovery:** The app discovers upstream repos automatically by searching for issues and PRs involving you across GitHub (not limited to your selected repos). Discovered repos appear in **Settings > Repositories** under "Upstream repos" and are added to issue and PR fetches.

**Manual management:** You can add or remove upstream repos manually in the Settings repo panel.

Upstream repos are included in Issues and Pull Requests fetches but excluded from the Actions tab, since workflow run access requires explicit repo permissions.

---

## Refresh and Polling

### Full Refresh

The dashboard polls GitHub at a configurable interval (default: **5 minutes**). Each full refresh fetches all issues, PRs, and workflow runs. You can trigger a manual refresh by clicking the refresh button in the header.

Setting the interval to **Off** disables automatic polling; manual refresh still works.

A ±30 second jitter is applied to the refresh interval to avoid synchronized API spikes from multiple browser tabs.

### Hot Poll

A second, faster poll loop runs alongside the full refresh specifically for in-flight items. It targets:

- **PRs with pending CI checks** — re-checks status until checks resolve
- **In-progress workflow runs** — re-checks until the run completes

Default interval: **30 seconds** (configurable from 10 to 120 seconds in Settings).

While the hot poll is active, a subtle shimmer animation appears on affected PR rows. When a status changes, the row flashes briefly to draw attention.

The hot poll pauses automatically when the browser tab is hidden (since visual feedback has no value in a background tab).

Hover the rate limit display in the dashboard footer to see detailed remaining counts for the Core and GraphQL API pools, plus the reset time.

### Tab Visibility Behavior

When the tab is hidden:

- The **hot poll always pauses** (it provides only visual feedback).
- The **full poll continues in background** when the notifications gate is available (OAuth or classic PAT with `notifications` scope). The gate uses `If-Modified-Since` headers for near-zero-cost 304 checks that do not count against your rate limit.
- When the notifications gate is **unavailable** (fine-grained PAT or classic PAT missing the `notifications` scope), the full poll also pauses in background tabs to conserve API budget.

When you return to a tab that has been hidden for more than 2 minutes, a catch-up fetch fires immediately regardless of where the timer is in its cycle.

---

## Notifications

### Notification Drawer

The bell icon in the header opens the notification drawer, which shows API errors, rate limit warnings, and other system messages. Notifications are dismissed automatically when the underlying condition clears on the next poll cycle.

### Browser Push Notifications

Browser push notifications are disabled by default. To enable them:

1. Go to **Settings > Notifications**.
2. Click **Grant permission** and allow notifications in the browser prompt.
3. Toggle **Enable notifications** on.

Per-type toggles (all default to on when notifications are enabled):

| Toggle | What triggers a notification |
|--------|------------------------------|
| Issues | New issues are opened in your tracked repos |
| Pull Requests | New PRs are opened or updated |
| Workflow Runs | Workflow runs complete |

---

## Tracked Items

The Tracked tab lets you pin issues and PRs into a personal TODO list that you can manually reorder by priority.

**Enabling:** Go to **Settings > Tabs** and toggle **Enable tracked items**. A fourth **Tracked** tab appears on the dashboard.

**Pinning items:** On the Issues and Pull Requests tabs, hover over any row to reveal a bookmark icon. Click it to pin the item to your tracked list. Click it again to unpin. The bookmark appears filled and highlighted on tracked items.

**Tracked tab:** Shows your pinned items in a flat list (not grouped by repo). Each item shows a repo badge, a type badge (Issue or PR), and uses live data from the poll cycle — labels, comments, and timestamps stay current. Tracked PRs display the same metadata as the Pull Requests tab: review status, size badge, check status dot, draft indicator, and role badge. Tracked issues show a role badge (author/assignee). In compact density, the repo badge abbreviates to just the repo name (hover for the full owner/repo). Items whose repo is no longer being polled show a minimal fallback row with stored metadata. PRs being hot-polled show a shimmer animation and a spinner in the left margin.

**Reordering:** Use the chevron buttons on the left side of each row to move items up or down. Items slide smoothly into their new position.

**Auto-removal:** When a tracked issue is closed or a tracked PR is merged, it is automatically removed from the list. Closure is detected by absence from the `is:open` poll results. For PRs detected as closed by the hot poll, removal happens within seconds. Auto-removal is suspended when the API returns errors (e.g., rate limiting) to prevent false pruning.

**Relationship to other features:** The Tracked tab bypasses the org/repo filter — it always shows all your pinned items regardless of which repo filter is active. Ignoring an item from the Issues or Pull Requests tab also removes it from the tracked list. The tracked list is preserved when tracking is disabled and restored when re-enabled.

---

## Repo Pinning

Each repo group header has a pin (lock) control, visible on hover on desktop and always visible on mobile. Pinning a repo keeps it at the top of the list on all tabs regardless of sort order or how recently it was updated. Pinned repos remain visible even when filters exclude all their items — they appear as compact, de-emphasized rows with the repo name and pin controls still accessible.

- Click the pin icon to pin a repo to the top.
- Click it again to unpin.
- Use the up/down arrows (visible when pinned) to reorder pinned repos relative to each other.

Pin state is shared across all tabs — pinning a repo on the Issues tab also pins it on Pull Requests and Actions.

---

## MCP Server Integration

The MCP (Model Context Protocol) server lets AI clients like Claude Code and Cursor query your dashboard data — open PRs, issues, failing CI — without leaving the editor.

MCP access is fully opt-in. Nothing is exposed unless you explicitly run the standalone server or enable the WebSocket relay in Settings.

### Standalone mode

Run the MCP server with a GitHub token for direct API access:

```bash
GITHUB_TOKEN=ghp_... npx github-tracker-mcp
```

This works without the dashboard open. The server fetches data directly from GitHub using the token. See the [MCP server README](https://github.com/gordon-code/github-tracker/tree/main/mcp) for Claude Code configuration and the full tool reference.

### WebSocket relay mode

For richer data without extra API calls, connect the MCP server to the running dashboard:

1. Open **Settings > MCP Server Relay**
2. Toggle **Enable relay** on
3. The status indicator shows "Connected" when the MCP server is running and linked

When connected, the MCP server receives live dashboard data over a local WebSocket connection (`ws://127.0.0.1:9876`). This provides the same enriched data you see in the dashboard — GraphQL-sourced review decisions, check statuses, and reviewer lists — without consuming additional API quota.

The relay falls back to direct GitHub API calls automatically when the dashboard is closed. Set `GITHUB_TOKEN` even when using the relay as a safety net — without it, all tool calls fail if the relay disconnects.

### Available tools

| Tool | What it returns |
|------|----------------|
| `get_dashboard_summary` | Counts: open PRs, open issues, failing CI, PRs needing review, approved but unmerged |
| `get_open_prs` | Open PRs with CI status, review decision, size, reviewers |
| `get_open_issues` | Open issues across tracked repos |
| `get_failing_actions` | In-progress or recently failed workflow runs |
| `get_pr_details` | Full details for a specific PR |
| `get_rate_limit` | Current GitHub API quota |

---

## Settings Reference

Settings are saved automatically to `localStorage` and persist across sessions. All settings can be exported as a JSON file via **Settings > Data > Export**.

### Config Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Refresh interval | 5 minutes | How often to poll GitHub for new data. Options: 1, 2, 5, 10, 15, 30 minutes, or Off. |
| CI status refresh (hot poll interval) | 30 seconds | How often to re-check in-flight CI checks and workflow runs. Range: 10–120 seconds. |
| Max workflows per repo | 5 | Number of active workflows to track per repository. Range: 1–20. |
| Max runs per workflow | 3 | Number of recent runs to show per workflow. Range: 1–10. |
| Notifications enabled | Off | Master toggle for browser push notifications. |
| Notify: Issues | On | Notify when new issues open (requires notifications enabled). |
| Notify: Pull Requests | On | Notify when PRs are opened or updated (requires notifications enabled). |
| Notify: Workflow Runs | On | Notify when workflow runs complete (requires notifications enabled). |
| Theme | Auto | UI color theme. Auto follows system dark/light preference (Corporate for light, Dim for dark). |
| View density | Comfortable | Spacing between list items. Options: Comfortable, Compact. |
| Items per page | 25 | Number of items per page in each tab. Options: 10, 25, 50, 100. |
| Default tab | Issues | Tab shown when opening the dashboard fresh (without remembered last tab). |
| Remember last tab | On | Return to the last active tab on revisit. |
| Enable tracked items | Off | Show the Tracked tab for pinning issues and PRs to a personal TODO list. |
| API Usage | — | Displays per-source API call counts, pool labels (Core/GraphQL), and last-called timestamps for the current rate limit window. Counts auto-reset when the rate limit window expires. Use "Reset counts" to clear manually. |
| MCP relay enabled | Off | Allow a local MCP server to receive live dashboard data over WebSocket. |
| MCP relay port | 9876 | Port for the WebSocket relay connection. Must match the MCP server's `MCP_WS_PORT`. |

### View State Settings

These are UI preferences that persist across sessions but are not included in the exported config file.

| Setting | Default | Description |
|---------|---------|-------------|
| Scope filter (Issues) | Involves me | Whether to show only items involving you or all activity. |
| Scope filter (Pull Requests) | Involves me | Whether to show only items involving you or all activity. |
| Show PR runs (Actions) | Off | Whether to show workflow runs triggered by pull request events. |
| Hide Dependency Dashboard | On | Whether to hide the Renovate Dependency Dashboard issue. |
| Sort preferences | Updated (desc) | Sort field and direction per tab, remembered across sessions. |
| Pinned repos | (none) | Repos pinned to the top of the list across all tabs. |
| Tracked items | (none) | Issues and PRs pinned to the Tracked tab (max 200). |

---

## Troubleshooting

**Items I expect to see are not showing up.**

- Check that the Scope filter is set correctly. "Involves me" shows items involving you or your tracked users; items from monitored repos where you are not directly involved (author, assignee, or reviewer) are hidden. Switch to "All activity" to see everything.
- Verify the repo is in your selected repo list (Settings > Repositories).
- Check if the item was accidentally ignored (toolbar Ignored badge).
- If you recently added the repo, wait for the next full refresh or click the manual refresh button.

**I see a rate limit warning.**

The tracker uses GitHub's GraphQL and REST APIs. Each poll cycle consumes some of your 5,000 request hourly budget. Tracking many repos, tracked users, or having a short refresh interval increases consumption. Increasing the refresh interval or reducing the number of tracked repos will reduce API usage.

OAuth tokens and classic PATs use the notifications gate (304 shortcut), which significantly reduces per-cycle cost when nothing has changed. Fine-grained PATs do not support this optimization.

For detailed per-source API call counts, see Settings > API Usage.

**PAT vs OAuth: what is the difference?**

OAuth tokens (from "Sign in with GitHub") work across all your organizations and support all features including the notifications background-poll optimization. Classic PATs with the correct scopes (`repo`, `read:org`, `notifications`) behave identically to OAuth.

Fine-grained PATs are limited to one organization at a time, do not support the `notifications` scope, and therefore cannot use the background-poll optimization — the full poll pauses in hidden tabs, and a warning appears in the notification drawer.

**Data looks stale after switching back to the tab.**

When a tab has been hidden for more than 2 minutes, a catch-up fetch fires automatically on return. If the notifications gate is unavailable (fine-grained PAT), polling was paused while the tab was hidden — the catch-up fetch provides a single refresh on return. To ensure continuous background updates, use OAuth or a classic PAT with the `notifications` scope.

**I want to stop tracking a repository.**

Go to **Settings > Repositories > Manage Repositories**, find the repo, and deselect it. If it was in the monitored list, it will be removed from monitoring automatically.

**MCP relay shows "Connecting..." but never connects.**

- Verify the MCP server is running (`GITHUB_TOKEN=ghp_... npx github-tracker-mcp` or `pnpm mcp:serve`)
- Check that the port in Settings matches the MCP server's port (default: 9876)
- The MCP server binds to `127.0.0.1` only — it must run on the same machine as your browser

**MCP tools return empty or stale data.**

- If the dashboard is open with the relay enabled, the MCP server uses live dashboard data. Navigate to the Dashboard tab to trigger a data load.
- If the dashboard is closed, the MCP server falls back to direct API calls using `GITHUB_TOKEN`. REST search lacks check status and review decision data, so PR filters like `failing` and `approved` may return empty results. Use the relay for full filter accuracy.
- The relay snapshot updates on each full refresh (every 5 minutes by default). Hot poll updates are not forwarded to the relay.

**How do I sign out or reset everything?**

- **Sign out**: Settings > Data > Sign out. This clears your auth token and returns you to the login page. Your config is preserved.
- **Reset all**: Settings > Data > Reset all. This clears all settings, cache, auth tokens, API usage data, and reloads the page. All configuration is lost.

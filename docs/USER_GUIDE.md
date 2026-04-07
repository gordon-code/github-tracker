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
- [Repo Pinning](#repo-pinning)
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

The dashboard has three tabs:

| Tab | Contents |
|-----|----------|
| **Issues** | Open issues across your selected repos where you are the author, assignee, or mentioned |
| **Pull Requests** | Open PRs where you are the author, reviewer, or assignee |
| **Actions** | Recent workflow runs for your selected repos |

The active tab is remembered across page loads by default. You can set a fixed default tab in Settings.

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

- **Involves me** (default) — shows only items where you (the signed-in user) are the author, assignee, reviewer, or mentioned. For monitored repos, all activity in that repo is always shown regardless of scope.
- **All activity** — shows every open item across your selected repos. Items that involve you are highlighted with a blue left border.

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

**Effect on display:** Repo groups for monitored repos show a **Monitoring all** badge in their header. Items from monitored repos are always visible even when the Scope filter is set to "Involves me", and they bypass the User filter.

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

## Repo Pinning

Each repo group header has a pin (lock) control, visible on hover on desktop and always visible on mobile. Pinning a repo keeps it at the top of the list within its tab regardless of sort order or how recently it was updated.

- Click the pin icon to pin a repo to the top.
- Click it again to unpin.
- Use the up/down arrows (visible when pinned) to reorder pinned repos relative to each other.

Pin state is per-tab — a repo can be pinned on the Issues tab but not the Pull Requests tab.

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

### View State Settings

These are UI preferences that persist across sessions but are not included in the exported config file.

| Setting | Default | Description |
|---------|---------|-------------|
| Scope filter (Issues) | Involves me | Whether to show only items involving you or all activity. |
| Scope filter (Pull Requests) | Involves me | Whether to show only items involving you or all activity. |
| Show PR runs (Actions) | Off | Whether to show workflow runs triggered by pull request events. |
| Hide Dependency Dashboard | On | Whether to hide the Renovate Dependency Dashboard issue. |
| Sort preferences | Updated (desc) | Sort field and direction per tab, remembered across sessions. |
| Pinned repos | (none) | Repos pinned to the top of each tab's list. |

---

## Troubleshooting

**Items I expect to see are not showing up.**

- Check that the Scope filter is set correctly. "Involves me" hides items where you have no direct involvement. Switch to "All activity" to see everything.
- Verify the repo is in your selected repo list (Settings > Repositories).
- Check if the item was accidentally ignored (toolbar Ignored badge).
- If you recently added the repo, wait for the next full refresh or click the manual refresh button.

**I see a rate limit warning.**

The tracker uses GitHub's GraphQL and REST APIs. Each poll cycle consumes some of your 5,000 request hourly budget. Tracking many repos, tracked users, or having a short refresh interval increases consumption. Increasing the refresh interval or reducing the number of tracked repos will reduce API usage.

OAuth tokens and classic PATs use the notifications gate (304 shortcut), which significantly reduces per-cycle cost when nothing has changed. Fine-grained PATs do not support this optimization.

**PAT vs OAuth: what is the difference?**

OAuth tokens (from "Sign in with GitHub") work across all your organizations and support all features including the notifications background-poll optimization. Classic PATs with the correct scopes (`repo`, `read:org`, `notifications`) behave identically to OAuth.

Fine-grained PATs are limited to one organization at a time, do not support the `notifications` scope, and therefore cannot use the background-poll optimization — the full poll pauses in hidden tabs, and a warning appears in the notification drawer.

**Data looks stale after switching back to the tab.**

When a tab has been hidden for more than 2 minutes, a catch-up fetch fires automatically on return. If the notifications gate is unavailable (fine-grained PAT), polling was paused while the tab was hidden — the catch-up fetch provides a single refresh on return. To ensure continuous background updates, use OAuth or a classic PAT with the `notifications` scope.

**I want to stop tracking a repository.**

Go to **Settings > Repositories > Manage Repositories**, find the repo, and deselect it. If it was in the monitored list, it will be removed from monitoring automatically.

**How do I sign out or reset everything?**

- **Sign out**: Settings > Data > Sign out. This clears your auth token and returns you to the login page. Your config is preserved.
- **Reset all**: Settings > Data > Reset all. This clears all settings, cache, auth tokens, and reloads the page. All configuration is lost.

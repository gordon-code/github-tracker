<p align="center">
  <img src="public/assets/logo.svg" width="96" height="96" alt="GitHub Tracker logo">
</p>

# GitHub Tracker

Dashboard SPA tracking GitHub issues, PRs, and GHA workflow runs across multiple repos/orgs. Built with SolidJS on Cloudflare Workers.

## Features

- **Issues Tab** — Open issues where you're the creator, assignee, or mentioned. Sortable, filterable, paginated. Dependency Dashboard issues hidden by default (toggleable).
- **Pull Requests Tab** — Open PRs with CI check status indicators (green/yellow/red dots). Draft badges, reviewer names.
- **Actions Tab** — GHA workflow runs grouped by repo and workflow. Accordion collapse, PR run toggle.
- **Onboarding Wizard** — Single-step repo selection with search filtering and bulk select.
- **PAT Authentication** — Optional Personal Access Token login as alternative to OAuth. Client-side format validation, detailed token creation instructions for classic and fine-grained PATs.
- **Settings Page** — Refresh interval, notification preferences, theme (light/dark/system), density, GitHub Actions limits. Shows current auth method and hides OAuth-specific options for PAT users.
- **Desktop Notifications** — New item alerts with per-type toggles and batching.
- **Ignore System** — Hide specific items with an "N ignored" badge and unignore popover.
- **Dark Mode** — System-aware with flash prevention via inline script + CSP SHA-256 hash.
- **ETag Caching** — Conditional requests (304s are free against GitHub's rate limit).
- **Auto-refresh** — Background polling keeps data fresh even in hidden tabs (requires notifications scope for efficient 304 change detection); hot poll pauses to save API budget.

## Tech Stack

- **Frontend:** SolidJS + Tailwind CSS v4 + TypeScript (strict)
- **Build:** Vite 8 + @cloudflare/vite-plugin
- **Hosting:** Cloudflare Workers (static assets + OAuth endpoint)
- **API:** @octokit/core with throttling, retry, pagination plugins
- **State:** localStorage (config/view) + IndexedDB (API cache with ETags)
- **Testing:** Vitest 4 (happy-dom for browser, @cloudflare/vitest-pool-workers for Worker)
- **Package Manager:** pnpm

## Development

```sh
pnpm install
pnpm run dev        # Start Vite dev server
pnpm test           # Run unit/component tests
pnpm run typecheck  # TypeScript check
pnpm run build      # Production build (~241KB JS, ~31KB CSS)
```

## Project Structure

```
src/
  app/
    components/
      dashboard/    # DashboardPage, IssuesTab, PullRequestsTab, ActionsTab, ItemRow, WorkflowRunRow, IgnoreBadge
      layout/       # Header, TabBar, FilterBar
      onboarding/   # OnboardingWizard, OrgSelector, RepoSelector
      settings/     # SettingsPage (7 config sections + data management)
      shared/       # FilterInput, LoadingSpinner, StatusDot
    pages/          # LoginPage, OAuthCallback
    services/
      api.ts        # GitHub API methods (fetchOrgs, fetchRepos, fetchIssues, fetchPRs, fetchWorkflowRuns)
      github.ts     # Octokit client factory with ETag caching and rate limit tracking
      poll.ts       # Poll coordinator with background refresh + hot poll for in-flight items
    stores/
      auth.ts       # OAuth token management (localStorage persistence, validateToken)
      cache.ts      # IndexedDB cache with TTL eviction and ETag support
      config.ts     # Zod v4-validated config with localStorage persistence
      view.ts       # View state (tabs, sorting, ignored items, filters)
    lib/
      pat.ts            # PAT format validation and token creation instruction constants
      notifications.ts  # Desktop notification permission, detection, and dispatch
  worker/
    index.ts        # OAuth token exchange endpoint, CORS, security headers
tests/
  fixtures/         # GitHub API response fixtures (orgs, repos, issues, PRs, runs)
  services/         # API service, Octokit client, and poll coordinator tests
  stores/           # Config and cache store tests
  components/       # ItemRow and IssuesTab component tests
  lib/              # Notification tests
  worker/           # Worker OAuth endpoint tests
```

## Security

- Strict CSP: `script-src 'self'` (SHA-256 exception for dark mode script only)
- PAT tokens stored in `localStorage` (same key as OAuth tokens) — single-user personal dashboard threat model
- OAuth CSRF protection via `crypto.getRandomValues` state parameter
- CORS locked to exact origin (strict equality, no substring matching)
- Access token stored in `localStorage` under app-specific key; CSP prevents XSS token theft
- Token validation on page load via `GET /user`; 401 clears auth immediately (no silent refresh)
- All GitHub API strings auto-escaped by SolidJS JSX (no innerHTML)
- `repo` scope granted (required for private repos) — app never performs write operations

## Deployment

See [DEPLOY.md](./DEPLOY.md) for Cloudflare, OAuth App, and CI/CD setup.

# GitHub Tracker

Dashboard SPA tracking GitHub issues, PRs, and GHA workflow runs across multiple repos/orgs.

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
pnpm test           # Run browser tests
pnpm run typecheck  # TypeScript check
pnpm run build      # Production build
```

## Project Structure

```
src/
  app/
    components/
      dashboard/    # DashboardPage, IssuesTab, ActionsTab, ItemRow, WorkflowRunRow
      layout/       # Header, TabBar, FilterBar
      onboarding/   # OnboardingWizard, OrgSelector, RepoSelector
      settings/     # SettingsPage (pending)
      shared/       # FilterInput, LoadingSpinner, StatusDot
    pages/          # LoginPage, OAuthCallback
    services/
      api.ts        # GitHub API methods (fetchOrgs, fetchRepos, fetchIssues, fetchPRs, fetchWorkflowRuns)
      github.ts     # Octokit client factory with ETag caching and rate limit tracking
      poll.ts       # Poll coordinator (pending)
    stores/
      auth.ts       # OAuth token management with refresh
      cache.ts      # IndexedDB cache with TTL eviction
      config.ts     # Zod-validated config with localStorage persistence
      view.ts       # View state (tabs, sorting, ignored items, filters)
    lib/
      notifications.ts  # Desktop notifications (pending)
  worker/
    index.ts        # OAuth token exchange/refresh endpoint, CORS, security headers
tests/
  fixtures/         # GitHub API response fixtures
  services/         # API and Octokit client tests
  stores/           # Config and cache tests
  worker/           # Worker OAuth endpoint tests
```

## Deployment

See [DEPLOY.md](./DEPLOY.md) for Cloudflare, GitHub App, and CI/CD setup.

# Contributing

## Development setup

**Prerequisites:** Node.js 24+, pnpm 10+

```bash
git clone https://github.com/gordon-code/github-tracker.git
cd github-tracker
pnpm install
pnpm run dev
```

The dev server starts at `http://localhost:5173`. You'll need a GitHub OAuth app client ID in `.env` (copy `.env.example` and fill in your value).

**Jira integration (optional):** The Jira Cloud integration is opt-in. Tests run without Jira credentials. To develop or test the Jira features locally:

1. Add `VITE_JIRA_CLIENT_ID=<your-atlassian-oauth-client-id>` to `.env` — this gates visibility of the Jira section in Settings
2. Add `JIRA_CLIENT_ID` and `JIRA_CLIENT_SECRET` to `.dev.vars` (copy from `.dev.vars.example`) — these are used by the Cloudflare Worker for OAuth token exchange

In production, provision `JIRA_CLIENT_ID` and `JIRA_CLIENT_SECRET` as Worker secrets via `wrangler secret put`. Never commit them to `.env` or `.dev.vars`.

The repo uses a pnpm workspace: the root package is the SolidJS SPA; `mcp/` is a separate package (`github-tracker-mcp`) built with tsup. Running `pnpm install` at the root installs both.

`pnpm-workspace.yaml` sets `minimumReleaseAge: 10080`, so dependency resolution only picks package versions published at least 7 days ago. pnpm applies this to every resolution, including lockfile regeneration (Renovate's lockfile maintenance runs pnpm with this workspace config), which keeps `pnpm-lock.yaml` installable under local supply-chain cooldowns of up to 7 days. If an install reports `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, the lockfile was produced without this policy — regenerate it rather than relaxing the policy.

To run the MCP server in standalone mode, set `GITHUB_TOKEN` before starting:

```bash
GITHUB_TOKEN=ghp_... pnpm mcp:serve
```

Fine-grained PATs need Actions (read), Contents (read), Issues (read), and Pull requests (read) permissions.

## Running checks

```bash
pnpm test              # unit tests (Vitest — root + mcp/)
pnpm test:e2e          # Playwright E2E tests (chromium against vite dev, plus *.preview.spec.ts against pnpm build && vite preview; rebuilds dist/)
pnpm test:e2e:preview  # Only the *.preview.spec.ts E2E tests (stale-chunk and offline handling on the production build)
E2E_SERVERS=dev pnpm test:e2e  # Skip the production build and preview server (dev-server specs only)
pnpm test:e2e:cross-browser  # Only the @cross-browser-tagged E2E tests, on Firefox + WebKit (first run: pnpm exec playwright install firefox webkit)
pnpm test:status-smoke # Live-network check that githubstatus.com still reports the tracked component names (also runs on a weekly schedule in CI)
pnpm run typecheck     # TypeScript validation (root + mcp/)
pnpm lint              # Type-aware lint check (oxlint — root + mcp/)
pnpm lint:fix          # Auto-fix safe lint findings (oxlint)
pnpm run screenshot    # Capture dashboard screenshot (saves to docs/)
pnpm bundle:report     # Build and print client bundle sizes + top-20 entry modules (deploy-safe)
pnpm mcp:serve         # Start the MCP server (requires GITHUB_TOKEN)
```

To test MCP tools interactively, use the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector tsx mcp/src/index.ts
```

CI runs typecheck, lint (`oxlint`), unit tests, and E2E tests (Chromium, plus the `@cross-browser` subset on Firefox and WebKit in a separate job) on every PR, and lint is also enforced pre-commit via `prek` alongside typecheck and unit tests. Make sure they pass locally before pushing.

To run a specific test file:

```bash
pnpm test -- tests/path/to/test.ts
```

## Code style

**TypeScript:** strict mode throughout. Don't use `any` — if you're reaching for it, there's usually a better type.

**SolidJS patterns:**
- Use `createMemo` for derived state; don't recompute inside JSX
- Use `<Show>` and `<Switch>`/`<Match>` instead of ternaries or early returns
- Early returns in components break SolidJS reactivity — use `<Show>` as a wrapper instead

**UI components:**
- Tailwind v4 + daisyUI v5 for styling — use semantic classes (`btn`, `card`, `badge`) over raw utilities where possible
- @kobalte/core for interactive primitives that need accessibility (Select, Tabs, Dialog)
- Don't reach for a custom implementation when Kobalte has a well-tested one

**Validation:** Zod v4 for all runtime validation. Note that nested `.default({})` doesn't apply inner field defaults — be explicit.

**Persisted schemas (`src/shared/schemas.ts`, `src/shared/view-schema.ts`):** the build fingerprints what `ConfigSchema` and `ViewStateSchema` accept; when a deploy changes it, tabs still on the older build turn read-only until reloaded. Keys, types, enums, patterns, array limits and defaults are covered automatically. A limit enforced by `.refine()` is invisible to that, so put it in `PERSISTED_LIMITS` (or export it like `TRACKED_USER_AVATAR_PREFIX`) and let the refine read it; a test fails if a refine is added without being accounted for. Tag a new E2E test `{ tag: "@cross-browser" }` to also run it on Firefox and WebKit in CI.

## Testing

Tests live in `tests/` and mirror the `src/` directory structure. Test files end in `.test.ts` or `.test.tsx`. BDD step definitions end in `.steps.tsx` and are also picked up by Vitest automatically.

Factory helpers in `tests/helpers/index.tsx` (`makeIssue`, `makePullRequest`, `makeWorkflowRun`) give you typed test fixtures — use them instead of hand-rolling objects.

A few things to know:
- `createResource` error state is unreliable in happy-dom; use manual signals with `onMount` + async functions instead
- Kobalte Select uses `aria-labelledby`, which overrides `aria-label` — query by regex in tests
- If you're testing auth state, call `vi.resetModules()` and use dynamic imports — `auth.ts` reads localStorage at module scope

## Branch and commit conventions

Branch from `main`. Use one of these prefixes:

- `feat/` — new functionality
- `fix/` — bug fixes
- `perf/` — performance changes
- `ci/` — CI/release workflow changes
- `docs/` — documentation only
- `refactor/` — code changes with no behavior change
- `test/` — test additions or fixes
- `chore/` — build, deps, tooling

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description
```

Scope is optional. Use imperative mood: "add feature", not "adds feature" or "added feature".

## Releases

Both the root application (`github-tracker`) and the MCP server (`github-tracker-mcp` in `mcp/`) are released automatically with [release-please](https://github.com/googleapis/release-please) via `.github/workflows/release.yml` (`release-please-config.json` and `.release-please-manifest.json`).

- **Never hand-edit versions or changelogs:** Do not manually edit `version` in `package.json`, `mcp/package.json`, `mcp/src/index.ts` (`// x-release-please-version`), or `.release-please-manifest.json`, and do not hand-edit `CHANGELOG.md` or `mcp/CHANGELOG.md`. Never manually create or push `github-tracker@*` or `github-tracker-mcp@*` tags.
- **Conventional Commits drive release notes and version bumps:**
  - `feat:` bumps the minor version and appears under **Features**
  - `fix:` bumps the patch version and appears under **Bug Fixes**
  - `perf:` bumps the patch version and appears under **Performance**
  - `feat!:` / `fix!:` / `BREAKING CHANGE:` footer bumps the major version
  - `docs:`, `chore:`, `ci:`, `refactor:`, `test:`, `build:`, `style:`, and `revert:` are hidden from changelog sections
  - Changes under `mcp/` scope to `github-tracker-mcp`; all other paths scope to `github-tracker`
- **Release PR flow:** When releasable commits land on `main`, `release.yml` opens or updates a release PR that bumps versions and updates `CHANGELOG.md` / `mcp/CHANGELOG.md`. Merging that release PR creates the git tag (`github-tracker@x.y.z` or `github-tracker-mcp@x.y.z`), publishes the GitHub Release, deploys the web application + Worker to Cloudflare (`deploy.yml` via `workflow_call`) when `github-tracker` is released, and publishes `github-tracker-mcp` to npm via OIDC trusted publishing (`release.yml`, environment `npm-publish`) when `mcp` is released. Emergency or out-of-band deployments can still be triggered manually from `main` via `workflow_dispatch` on `deploy.yml`.

See [DEPLOY.md](DEPLOY.md#releases) for the maintainer setup (GitHub App permissions, `release` and `npm-publish` environments, npm trusted publisher binding, and tag ruleset).

### First publish for forks (manual, one-time)

If you are publishing your own renamed MCP package from a fork, the very first publish to npm must be done locally because npm OIDC trusted publishing can only be configured for packages that already exist on npm:

1. Create an npm account at [npmjs.com](https://www.npmjs.com/signup) and log in locally (`npm login`)
2. Build and publish once:
   ```bash
   cd mcp
   pnpm run build
   pnpm publish --access public
   ```
3. On **npmjs.com > your package > Settings > Trusted Publishers**, bind your repository's `release.yml` workflow and `npm-publish` environment.

## Pull requests

All PRs target `main` on `gordon-code/github-tracker`. Keep PRs focused — one feature or fix per PR makes review faster and reverts cleaner.

In the PR body, describe what changed and why. CI runs typecheck, lint, unit tests, and E2E tests automatically. PRs need a passing CI run before merge.

When adding or changing user-facing features, update [docs/USER_GUIDE.md](docs/USER_GUIDE.md) to reflect the changes.

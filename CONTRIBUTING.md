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

To run the MCP server in standalone mode, set `GITHUB_TOKEN` before starting:

```bash
GITHUB_TOKEN=ghp_... pnpm mcp:serve
```

Fine-grained PATs need Actions (read), Contents (read), Issues (read), and Pull requests (read) permissions.

## Running checks

```bash
pnpm test           # unit tests (Vitest — root + mcp/)
pnpm test:e2e       # Playwright E2E tests (chromium)
pnpm run typecheck  # TypeScript validation (root + mcp/)
pnpm run screenshot # Capture dashboard screenshot (saves to docs/)
pnpm mcp:serve      # Start the MCP server (requires GITHUB_TOKEN)
```

To test MCP tools interactively, use the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector tsx mcp/src/index.ts
```

CI runs typecheck, unit tests, and E2E tests on every PR. Make sure they pass locally before pushing.

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
- `docs/` — documentation only
- `refactor/` — code changes with no behavior change
- `test/` — test additions or fixes
- `chore/` — build, deps, tooling

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description
```

Scope is optional. Use imperative mood: "add feature", not "adds feature" or "added feature".

## Releasing the MCP server

The MCP server (`mcp/` package) is published to npm and GitHub Releases via CI.

### First publish (manual)

The very first publish must be done locally — OIDC trusted publishing can only be configured for packages that already exist on npm.

1. Create an npm account at [npmjs.com](https://www.npmjs.com/signup) if you don't have one
2. Log in locally: `npm login`
3. Build and publish:
   ```bash
   cd mcp
   pnpm run build
   pnpm publish --access public
   ```

### Trusted publishing setup (one-time, after first publish)

CI publishes via npm OIDC trusted publishing — no tokens or secrets needed.

1. Go to **npmjs.com > github-tracker-mcp > Settings > Trusted Publishers**
2. Add a trusted publisher:
   - **Owner:** `gordon-code`
   - **Repository:** `github-tracker`
   - **Workflow filename:** `publish-mcp.yml`

### Cutting a release

```bash
cd mcp
pnpm version patch  # or minor|major, or manually bump version in package.json
git add package.json
git commit -m "chore(mcp): bump version to X.Y.Z"
git tag github-tracker-mcp@X.Y.Z  # The tag _must_ match the github-tracker-mcp@X.Y.Z pattern.
git push upstream main --follow-tags
```

`pnpm version` bumps `mcp/package.json`, commits, and creates a `github-tracker-mcp@X.Y.Z` tag. Pushing that tag to upstream triggers CI, which typechecks, builds, tests, publishes to npm, and creates a GitHub release.

## Pull requests

All PRs target `main` on `gordon-code/github-tracker`. Keep PRs focused — one feature or fix per PR makes review faster and reverts cleaner.

In the PR body, describe what changed and why. CI runs typecheck, unit tests, and E2E tests automatically. PRs need a passing CI run before merge.

When adding or changing user-facing features, update [docs/USER_GUIDE.md](docs/USER_GUIDE.md) to reflect the changes.

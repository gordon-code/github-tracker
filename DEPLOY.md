# Deployment Guide

## GitHub Actions Secrets and Variables

### Secrets (GitHub repo → Settings → Secrets and variables → Actions → Secrets)

**`CLOUDFLARE_API_TOKEN`**
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → My Profile → API Tokens
2. Click "Create Token"
3. Use the "Edit Cloudflare Workers" template
4. Scope to your account and zone as needed
5. Copy the token and add it as a secret

**`CLOUDFLARE_ACCOUNT_ID`**
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Select your account (Account Home)
3. Copy the Account ID from the right sidebar
4. Add it as a secret

### Variables (GitHub repo → Settings → Secrets and variables → Actions → Variables)

**`VITE_GITHUB_CLIENT_ID`**
- This is the GitHub App Client ID (not a secret — it is embedded in the built JS bundle)
- Add it as an Actions **variable** (not a secret)
- See GitHub App setup below for how to obtain it

## GitHub App Setup

1. Go to GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**
2. Fill in the basic details:
   - **App name**: your app name (e.g. `gh-tracker-yourname`)
   - **Description**: `Personal dashboard for tracking GitHub issues, PRs, and Actions runs across repos and orgs.`
   - **Homepage URL**: `https://gh.gordoncode.dev`
3. Under **Identifying and authorizing users**:
   - **Callback URLs** — register all three:
     - `https://gh.gordoncode.dev/oauth/callback` (production)
     - `https://github-tracker.<account>.workers.dev/oauth/callback` (preview — GitHub's subdomain matching should allow per-branch preview aliases like `alias.github-tracker.<account>.workers.dev` to work; verify after first preview deploy)
     - `http://localhost:5173/oauth/callback` (local dev)
   - ✅ **Expire user authorization tokens** — check this. The app uses short-lived access tokens (8hr) with HttpOnly cookie-based refresh token rotation.
   - ✅ **Request user authorization (OAuth) during installation** — check this. Streamlines the install + authorize flow into one step.
4. Under **Post installation**:
   - Leave **Setup URL** blank
   - Leave **Redirect on update** unchecked
5. Under **Webhook**:
   - ❌ Uncheck **Active** — the app polls; it does not use webhooks.
6. Under **Permissions**:

   **Repository permissions** (read-only):

   | Permission | Access | Used for |
   |------------|--------|----------|
   | **Actions** | Read-only | `GET /repos/{owner}/{repo}/actions/runs` — workflow run list |
   | **Checks** | Read-only | `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` — PR check status (REST fallback) |
   | **Commit statuses** | Read-only | `GET /repos/{owner}/{repo}/commits/{ref}/status` — legacy commit status (REST fallback) |
   | **Issues** | Read-only | `GET /search/issues?q=is:issue` — issue search |
   | **Metadata** | Read-only | Automatically granted when any repo permission is set. Required for basic repo info. |
   | **Pull requests** | Read-only | `GET /search/issues?q=is:pr`, `GET /repos/{owner}/{repo}/pulls/{pull_number}`, `/reviews` — PR search, detail, and reviews |

   **Organization permissions:**

   | Permission | Access | Used for |
   |------------|--------|----------|
   | **Members** | Read-only | `GET /user/orgs` — list user's organizations for the org selector |

   **Account permissions:**

   | Permission | Access | Used for |
   |------------|--------|----------|
   | _(none required)_ | | |

7. Under **Where can this GitHub App be installed?**:
   - **Any account** — the app uses OAuth authorization (not installation tokens), so any GitHub user needs to be able to authorize via the login flow
8. Click **Create GitHub App**
9. Note the **Client ID** — this is your `VITE_GITHUB_CLIENT_ID`
10. Click **Generate a new client secret** and save it for the Worker secrets below

### Notifications API limitation

The GitHub Notifications API (`GET /notifications`) does not support GitHub App user access tokens — only classic personal access tokens. The app uses notifications as a polling optimization gate (skip full fetch when nothing changed). When the notifications endpoint returns 403, the gate **auto-disables** and the app falls back to time-based polling. No functionality is lost; polling is just slightly less efficient.

## Cloudflare Worker Secrets

These are set via wrangler CLI and are stored in the Cloudflare Worker runtime (not in GitHub).

### Production environment

```sh
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put ALLOWED_ORIGIN
```

- `GITHUB_CLIENT_ID`: same value as `VITE_GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`: the Client Secret from your GitHub App
- `ALLOWED_ORIGIN`: `https://gh.gordoncode.dev`

### Preview versions

Preview deployments use `wrangler versions upload` (not a separate environment), so they inherit production secrets automatically. No additional secret configuration is needed.

CORS note: Preview URLs are same-origin (SPA and API share the same `*.workers.dev` host), so the `ALLOWED_ORIGIN` strict-equality check is irrelevant — browsers don't enforce CORS on same-origin requests.

**Migration note:** If you previously deployed with `wrangler deploy --env preview`, an orphaned `github-tracker-preview` worker may still exist. Delete it via `wrangler delete --name github-tracker-preview` or through the Cloudflare dashboard.

## Worker API Endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/oauth/token` | POST | none | Exchange OAuth code for access token. Refresh token set as HttpOnly cookie. |
| `/api/oauth/refresh` | POST | cookie | Refresh expired access token. Reads `github_tracker_rt` HttpOnly cookie. Sets rotated cookie. |
| `/api/oauth/logout` | POST | none | Clears the `github_tracker_rt` HttpOnly cookie (`Max-Age=0`). |
| `/api/health` | GET | none | Health check. Returns `OK`. |

### Refresh Token Security

The refresh token (6-month lifetime) is stored as an **HttpOnly cookie** — never in `localStorage` or the response body. This protects the high-value long-lived credential from XSS:

- Production cookie: `__Host-github_tracker_rt` with `HttpOnly; Secure; SameSite=Strict; Path=/`
- Local dev: `github_tracker_rt` with `HttpOnly; SameSite=Lax; Path=/` (no `Secure` — localhost is HTTP; no `__Host-` prefix — requires `Secure`)
- The short-lived access token (8hr) is held in-memory only (never persisted to `localStorage`); on page reload, `refreshAccessToken()` obtains a fresh token via the cookie
- On logout, the client calls `POST /api/oauth/logout` to clear the cookie
- GitHub rotates the refresh token on each use; the Worker sets the new value as a cookie

### CORS

- `Access-Control-Allow-Origin`: exact match against `ALLOWED_ORIGIN` (no wildcards)
- `Access-Control-Allow-Credentials: true`: enables cookie-based refresh for cross-origin preview deploys
- Same-origin requests (production, local dev) send cookies automatically without CORS

## Local Development

Copy `.dev.vars.example` to `.dev.vars` and fill in your values. Wrangler picks up `.dev.vars` automatically for local `wrangler dev` runs.

## Deploy Manually

```sh
pnpm run build
wrangler deploy
```

For preview (uploads a version without promoting to production):

```sh
pnpm run build
wrangler versions upload --preview-alias my-feature
```

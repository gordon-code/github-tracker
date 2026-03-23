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

1. Go to GitHub → Settings → Developer settings → GitHub Apps → New GitHub App
2. Fill in:
   - **App name**: your app name (e.g. `gh-tracker-yourname`)
   - **Homepage URL**: `https://gh.gordoncode.dev`
   - **Callback URLs**: register all three:
     - `https://gh.gordoncode.dev/oauth/callback` (production)
     - `https://github-tracker.<account>.workers.dev/oauth/callback` (preview — GitHub's subdomain matching should allow per-branch preview aliases like `alias.github-tracker.<account>.workers.dev` to work; verify after first preview deploy)
     - `http://localhost:5173/oauth/callback` (local dev)
   - **Webhook**: disable (uncheck "Active")
   - **Permissions**: set to read-only as needed (Issues, Pull requests, Actions, Metadata)
3. After creation, note the **Client ID** — this is your `VITE_GITHUB_CLIENT_ID`
4. Generate a **Client Secret** and save it for the Worker secrets below

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

- Cookie attributes: `HttpOnly; Secure; SameSite=Strict; Path=/api`
- Local dev uses `SameSite=Lax` without `Secure` (localhost is HTTP)
- The short-lived access token (8hr) remains in `localStorage`, defended by strict CSP
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

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
- This is the GitHub OAuth App Client ID (not a secret — it is embedded in the built JS bundle)
- Add it as an Actions **variable** (not a secret)
- See OAuth App setup below for how to obtain it

## GitHub OAuth App Setup

1. Go to GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**
2. Fill in the details:
   - **Application name**: your app name (e.g. `gh-tracker-yourname`)
   - **Homepage URL**: `https://gh.gordoncode.dev`
   - **Authorization callback URL**: `https://gh.gordoncode.dev/oauth/callback`
3. Click **Register application**
4. Note the **Client ID** — this is your `VITE_GITHUB_CLIENT_ID`
5. Click **Generate a new client secret** and save it for the Worker secrets below

### Scopes

The login flow requests `scope=repo read:org notifications`:

| Scope | Used for |
|-------|----------|
| `repo` | Read issues, PRs, check runs, workflow runs (includes private repos) |
| `read:org` | `GET /user/orgs` — list user's organizations for the org selector |
| `notifications` | `GET /notifications` — polling optimization gate (304 = skip full fetch) |

**Note:** The `repo` scope grants write access to repositories, but this app never performs write operations (POST/PUT/PATCH/DELETE on repo endpoints). It is read-only by design.

### Local development OAuth App

Create a second OAuth App for local development:
- **Authorization callback URL**: `http://localhost:5173/oauth/callback`
- Set its Client ID and Secret in `.dev.vars` (see Local Development below)

## Cloudflare Worker Secrets

These are set via wrangler CLI and are stored in the Cloudflare Worker runtime (not in GitHub).

### Production environment

```sh
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put ALLOWED_ORIGIN
```

- `GITHUB_CLIENT_ID`: same value as `VITE_GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`: the Client Secret from your GitHub OAuth App
- `ALLOWED_ORIGIN`: `https://gh.gordoncode.dev`

## Worker API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/oauth/token` | POST | Exchange OAuth authorization code for permanent access token. |
| `/api/health` | GET | Health check. Returns `OK`. |

### Token Storage Security

The OAuth App access token is a permanent credential (no expiry). It is stored in `localStorage` under the key `github-tracker:auth-token`:

- **CSP protects against XSS token theft**: `script-src 'self'` prevents injection of unauthorized scripts that could read `localStorage`
- On page load, `validateToken()` calls `GET /user` to verify the token is still valid
- On 401, the app immediately clears auth and redirects to login (token is revoked, not expired)
- On logout, the token is removed from `localStorage` and all local state is cleared
- Transient network errors do NOT clear the token (permanent tokens survive connectivity issues)

### CORS

- `Access-Control-Allow-Origin`: exact match against `ALLOWED_ORIGIN` (no wildcards)
- No `Access-Control-Allow-Credentials` header (OAuth App uses no cookies)

## Local Development

Copy `.dev.vars.example` to `.dev.vars` and fill in your values. Wrangler picks up `.dev.vars` automatically for local `wrangler dev` runs.

## Deploy Manually

```sh
pnpm run build
wrangler deploy
```

## Migration from GitHub App

If you previously deployed with the GitHub App model (HttpOnly cookie refresh tokens), follow these steps:

1. **Update GitHub Actions variable**: change `VITE_GITHUB_CLIENT_ID` to your OAuth App's Client ID
2. **Update Cloudflare secrets**: re-run `wrangler secret put GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` with OAuth App values
3. **Update `ALLOWED_ORIGIN`** if it changed (usually unchanged)
4. **Redeploy** the Worker: `pnpm run build && wrangler deploy`
5. **Existing users** will be logged out on next page load (their refresh cookie is no longer valid; they will be prompted to log in again via the new OAuth App flow)
6. **Delete the old GitHub App** (optional): GitHub → Settings → Developer settings → GitHub Apps → your app → Advanced → Delete

The old `POST /api/oauth/refresh` and `POST /api/oauth/logout` endpoints no longer exist and return 404.

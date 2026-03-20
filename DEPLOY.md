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
   - **Callback URLs**: register BOTH:
     - `https://gh.gordoncode.dev/oauth/callback` (production)
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

### Preview environment

Secrets are non-inheritable — the preview environment needs its own set:

```sh
wrangler secret put GITHUB_CLIENT_ID --env preview
wrangler secret put GITHUB_CLIENT_SECRET --env preview
wrangler secret put ALLOWED_ORIGIN --env preview
```

- `ALLOWED_ORIGIN` for preview: set to your Cloudflare Pages preview URL or `http://localhost:5173` for local testing

## Local Development

Copy `.dev.vars.example` to `.dev.vars` and fill in your values. Wrangler picks up `.dev.vars` automatically for local `wrangler dev` runs.

## Deploy Manually

```sh
pnpm run build
wrangler deploy
```

For preview:

```sh
pnpm run build
wrangler deploy --env preview
```

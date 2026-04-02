# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email **security@gordoncode.dev** with:

- A description of the vulnerability
- Steps to reproduce
- Any relevant logs or screenshots
- Your assessment of severity (if applicable)

You should receive an acknowledgment within 48 hours. I will work with you to understand and address the issue before any public disclosure.

## Scope

This policy covers:

- The github-tracker web application (`gh.gordoncode.dev`)
- The Cloudflare Worker backend (`src/worker/`)
- The OAuth authentication flow
- Client-side data handling and storage

## Out of Scope

- Vulnerabilities in third-party dependencies (report these to the upstream project)
- Issues requiring physical access to a user's device
- Social engineering attacks
- Denial of service attacks against GitHub's API (rate limits are GitHub's domain)

## Security Controls

This project implements the following security measures:

- **CSP**: Strict Content-Security-Policy with `default-src 'none'`, no `unsafe-eval`, no `unsafe-inline` for scripts (`style-src-attr 'unsafe-inline'` required by Kobalte UI library)
- **CORS**: Strict origin equality matching on the Worker
- **OAuth CSRF**: Cryptographically random state parameter with single-use enforcement
- **Read-only API access**: Octokit hook blocks all write operations
- **Input validation**: GraphQL query parameters validated against allowlisted patterns
- **Sentry PII scrubbing**: Error reports strip auth tokens, headers, cookies, and user identity
- **SHA-pinned CI**: All GitHub Actions pinned to full commit SHAs

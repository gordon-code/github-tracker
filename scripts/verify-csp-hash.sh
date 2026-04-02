#!/usr/bin/env bash
set -euo pipefail

SCRIPT=$(sed -n 's/.*<script>\([^<]*\)<\/script>.*/\1/p' index.html)
if [[ -z "$SCRIPT" ]]; then
  echo "No inline <script>...</script> found in index.html"
  [[ -n "${GITHUB_ACTIONS:-}" ]] && echo "::error::No inline <script>...</script> found in index.html"
  exit 1
fi
HASH=$(printf '%s' "$SCRIPT" | openssl dgst -sha256 -binary | base64)

if ! grep -qF "sha256-$HASH" public/_headers; then
  echo "CSP hash mismatch! Inline script hash 'sha256-$HASH' not found in public/_headers"
  echo "Update the sha256 hash in public/_headers to match the inline script in index.html"
  [[ -n "${GITHUB_ACTIONS:-}" ]] && echo "::error::CSP hash mismatch! Inline script hash 'sha256-$HASH' not found in public/_headers"
  exit 1
fi

echo "CSP hash verified: sha256-$HASH"

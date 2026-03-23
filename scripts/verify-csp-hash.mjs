#!/usr/bin/env node
/**
 * Verifies that the SHA-256 hash in public/_headers matches the inline
 * <script> content in index.html. Exits 1 if they diverge.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// ── 1. Extract inline script content from index.html ─────────────────────────

const html = readFileSync(resolve(root, "index.html"), "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  console.error("ERROR: No inline <script> found in index.html");
  process.exit(1);
}
const scriptContent = scriptMatch[1];

// ── 2. Compute SHA-256 of the script content ──────────────────────────────────

const computed = createHash("sha256").update(scriptContent).digest("base64");

// ── 3. Extract sha256- hash from public/_headers CSP ─────────────────────────

const headers = readFileSync(resolve(root, "public/_headers"), "utf8");
const hashMatch = headers.match(/sha256-([A-Za-z0-9+/=]+)/);
if (!hashMatch) {
  console.error("ERROR: No sha256- hash found in public/_headers CSP");
  process.exit(1);
}
const recorded = hashMatch[1];

// ── 4. Compare ────────────────────────────────────────────────────────────────

if (computed === recorded) {
  console.log(`CSP hash OK: sha256-${computed}`);
  process.exit(0);
} else {
  console.error("ERROR: CSP hash mismatch!");
  console.error(`  index.html script hash : sha256-${computed}`);
  console.error(`  _headers recorded hash : sha256-${recorded}`);
  console.error(
    "Update the sha256- value in public/_headers to match the inline script."
  );
  process.exit(1);
}

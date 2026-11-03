#!/usr/bin/env bash
# Usage: pnpm bundle:report
# Builds the application into dist-report/ with rollup-plugin-visualizer enabled
# for the client environment, prints raw + gzip -9 asset sizes and top-20 entry
# chunk modules, and preserves .wrangler/deploy/config.json so subsequent
# wrangler deploy invocations never ship the report build.
set -euo pipefail

WRANGLER_CONFIG=".wrangler/deploy/config.json"
WRANGLER_BACKUP=".wrangler/deploy/config.json.bak"
HAD_WRANGLER_CONFIG=0

if [[ -f "$WRANGLER_CONFIG" ]]; then
  HAD_WRANGLER_CONFIG=1
  cp "$WRANGLER_CONFIG" "$WRANGLER_BACKUP"
fi

cleanup() {
  if [[ "$HAD_WRANGLER_CONFIG" -eq 1 ]]; then
    if [[ -f "$WRANGLER_BACKUP" ]]; then
      mkdir -p "$(dirname "$WRANGLER_CONFIG")"
      mv "$WRANGLER_BACKUP" "$WRANGLER_CONFIG"
    fi
  else
    rm -f "$WRANGLER_CONFIG" "$WRANGLER_BACKUP"
  fi
}
trap cleanup EXIT

BUNDLE_REPORT=1 VITE_SENTRY_DSN=https://public@o0.ingest.sentry.io/0 pnpm exec vite build --outDir dist-report

node -e '
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const clientDir = path.join("dist-report", "client");
if (!fs.existsSync(clientDir)) {
  console.error("Missing client build directory:", clientDir);
  process.exit(1);
}

const files = [];
for (const sub of fs.readdirSync(clientDir, { withFileTypes: true })) {
  if (!sub.isDirectory()) continue;
  const subDir = path.join(clientDir, sub.name);
  for (const entry of fs.readdirSync(subDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/^.+-[^/]+\.(js|css)$/.test(entry.name)) continue;
    const relPath = path.posix.join(sub.name, entry.name);
    const fullPath = path.join(subDir, entry.name);
    const buf = fs.readFileSync(fullPath);
    const rawBytes = buf.length;
    const gzipBytes = zlib.gzipSync(buf, { level: 9 }).length;
    files.push({ relPath, name: entry.name, ext: path.extname(entry.name), rawBytes, gzipBytes });
  }
}

files.sort((a, b) => b.rawBytes - a.rawBytes);

const fmtKb = (bytes) => `${(bytes / 1024).toFixed(2)} KB (${bytes} B)`;

console.log("\n=== Client Hashed Assets (dist-report/client/*/*-*.{js,css}) ===");
let totalJsRaw = 0;
let totalJsGzip = 0;
let totalCssRaw = 0;
let totalCssGzip = 0;
let entryAsset = null;

for (const f of files) {
  if (f.ext === ".js") {
    totalJsRaw += f.rawBytes;
    totalJsGzip += f.gzipBytes;
    if (/^index-[^/]+\.js$/.test(f.name)) {
      entryAsset = f;
    }
  } else if (f.ext === ".css") {
    totalCssRaw += f.rawBytes;
    totalCssGzip += f.gzipBytes;
  }
  console.log(`${f.relPath.padEnd(48)} raw: ${fmtKb(f.rawBytes).padEnd(22)} gzip-9: ${fmtKb(f.gzipBytes)}`);
}

const htmlPath = path.join(clientDir, "index.html");
const initialRelPaths = new Set();
if (fs.existsSync(htmlPath)) {
  const html = fs.readFileSync(htmlPath, "utf8");
  for (const token of html.split(/\s+/)) {
    if (token.startsWith("src=") || token.startsWith("href=")) {
      const firstQuote = token.indexOf("=") + 1;
      const quoteChar = token[firstQuote];
      const endQuote = token.indexOf(quoteChar, firstQuote + 1);
      if (endQuote > firstQuote) {
        const val = token.slice(firstQuote + 1, endQuote).replace(/^\//, "");
        if (val.endsWith(".js")) initialRelPaths.add(val);
      }
    }
  }
}

console.log("\n=== Summary ===");
if (entryAsset) {
  console.log(`Entry JS (${entryAsset.relPath}): raw ${fmtKb(entryAsset.rawBytes)} | gzip-9 ${fmtKb(entryAsset.gzipBytes)}`);
}
const bootAssets = files.filter((f) => initialRelPaths.has(f.relPath) || (entryAsset && f.relPath === entryAsset.relPath));
if (bootAssets.length > 1) {
  const bootRaw = bootAssets.reduce((s, f) => s + f.rawBytes, 0);
  const bootGzip = bootAssets.reduce((s, f) => s + f.gzipBytes, 0);
  console.log(`Initial Boot JS (${bootAssets.map((f) => f.relPath).join(" + ")}): raw ${fmtKb(bootRaw)} | gzip-9 ${fmtKb(bootGzip)}`);
}
console.log(`Total JS:  raw ${fmtKb(totalJsRaw)} | gzip-9 ${fmtKb(totalJsGzip)}`);
console.log(`Total CSS: raw ${fmtKb(totalCssRaw)} | gzip-9 ${fmtKb(totalCssGzip)}`);

const statsPath = path.join("dist-report", "stats.json");
if (!fs.existsSync(statsPath)) {
  console.error("Missing visualizer stats file:", statsPath);
  process.exit(1);
}

const stats = JSON.parse(fs.readFileSync(statsPath, "utf8"));
const nodeMetas = Object.values(stats.nodeMetas || {});
const nodeParts = stats.nodeParts || {};

const bundleIds = new Set();
for (const meta of nodeMetas) {
  for (const bId of Object.keys(meta.moduleParts || {})) {
    bundleIds.add(bId);
  }
}
const entryBundleId = [...bundleIds].find((id) => /(?:^|\/)index-[^/]+\.js$/.test(id));
if (!entryBundleId) {
  console.error("Could not find entry chunk (index-*.js) in stats.json bundleIds:", [...bundleIds]);
  process.exit(1);
}

const bootBundleIds = [...bundleIds].filter((id) => initialRelPaths.has(id) || id === entryBundleId);
const bootLabel = bootBundleIds.join(" + ");

const entryModules = [];
let zodEntryBytes = 0;
const zodModules = [];

for (const meta of nodeMetas) {
  let renderedLength = 0;
  for (const bId of bootBundleIds) {
    const partUid = meta.moduleParts && meta.moduleParts[bId];
    if (!partUid) continue;
    const part = nodeParts[partUid];
    if (part && part.renderedLength) renderedLength += part.renderedLength;
  }
  if (!renderedLength) continue;
  entryModules.push({ id: meta.id, renderedLength });
  if (meta.id.includes("/node_modules/zod/") || meta.id.includes("/node_modules/.pnpm/zod@")) {
    zodEntryBytes += renderedLength;
    zodModules.push({ id: meta.id, renderedLength });
  }
}

entryModules.sort((a, b) => b.renderedLength - a.renderedLength);

console.log(`\n=== Top 20 Modules by Rendered Size in Entry/Boot Chunks (${bootLabel}) ===`);
for (const [idx, mod] of entryModules.slice(0, 20).entries()) {
  console.log(`${String(idx + 1).padStart(2)}. ${fmtKb(mod.renderedLength).padEnd(22)} ${mod.id}`);
}

console.log(`\n=== Entry/Boot Chunk Zod Breakdown (${bootLabel}) ===`);
console.log(`Total zod rendered in entry/boot chunks: ${fmtKb(zodEntryBytes)} across ${zodModules.length} module(s)`);
'

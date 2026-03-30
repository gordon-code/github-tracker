// Vendored from gemoji 8.1.0 — static shortcode→Unicode map (42KB, ~15KB gzipped).
// Regenerate: node -e "const {gemoji}=require('gemoji');const m={};for(const e of gemoji)for(const n of e.names)m[n]=e.emoji;process.stdout.write(JSON.stringify(m))" > src/app/lib/github-emoji-map.json
import emojiMap from "./github-emoji-map.json";

const SHORTCODE_RE = /:([a-z0-9_+-]+):/g;

const map = emojiMap as Record<string, string>;

/** Replace GitHub `:shortcode:` patterns with Unicode emoji. Unknown codes are left as-is. */
export function expandEmoji(text: string): string {
  if (!text.includes(":")) return text;
  return text.replace(SHORTCODE_RE, (match, name: string) => map[name] ?? match);
}

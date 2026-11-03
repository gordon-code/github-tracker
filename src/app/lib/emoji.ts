// Vendored from gemoji 8.1.0 — static shortcode→Unicode map (42KB, ~15KB gzipped).
// Regenerate: node -e "const {gemoji}=require('gemoji');const m={};for(const e of gemoji)for(const n of e.names)m[n]=e.emoji;process.stdout.write(JSON.stringify(m))" > src/app/lib/github-emoji-map.json
import { createSignal } from "solid-js";

const SHORTCODE_RE = /:([a-z0-9_+-]+):/g;

const [emojiVersion, setEmojiVersion] = createSignal(0);
let emojiMap: Record<string, string> | null = null;
let emojiLoadPromise: Promise<void> | null = null;

/** Lazily load the GitHub shortcode→Unicode emoji map and trigger reactive dependents. */
export function loadEmojiMap(): Promise<void> {
  if (emojiMap) return Promise.resolve();
  if (!emojiLoadPromise) {
    emojiLoadPromise = (async () => {
      try {
        const mod = await import("./github-emoji-map.json");
        emojiMap = mod.default;
        setEmojiVersion((v) => v + 1);
      } catch {
        emojiLoadPromise = null;
      }
    })();
  }
  return emojiLoadPromise;
}

/** @internal Test-only reset helper for pre-load emoji state */
export function _resetEmojiMapForTests(): void {
  emojiMap = null;
  emojiLoadPromise = null;
  setEmojiVersion((v) => v + 1);
}

/** Replace GitHub `:shortcode:` patterns with Unicode emoji. Unknown codes are left as-is. */
export function expandEmoji(text: string): string {
  emojiVersion();
  if (!text.includes(":") || !emojiMap) return text;
  const map = emojiMap;
  return text.replace(SHORTCODE_RE, (match, name: string) => map[name] ?? match);
}

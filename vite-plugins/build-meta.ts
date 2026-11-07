import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import * as z from "zod/mini";
import { createHash } from "node:crypto";
import { BUILD_SHA_LENGTH, COMMIT_SHA_PATTERN, COMMIT_SHA_RE, type BuildInfo } from "../src/shared/build-meta.ts";
import { ConfigSchema, TRACKED_USER_AVATAR_PREFIX } from "../src/shared/schemas.ts";
import { PERSISTED_LIMITS, ViewStateSchema } from "../src/shared/view-schema.ts";
import {
  CHANGELOG_MAX_ENTRIES,
  CHANGELOG_MAX_ITEM_TEXT_LENGTH,
  CHANGELOG_MAX_SECTION_TITLE_LENGTH,
  ChangelogSchema,
  type ChangelogEntry,
  type ChangelogItem,
  type ChangelogSection,
} from "../src/shared/changelog-schema.ts";

// Case-insensitive on purpose: GITHUB_SHA and `git rev-parse` output are normalized to lowercase below.
const HEX_SHA_RE = new RegExp(COMMIT_SHA_RE.source, "i");
const VIRTUAL_CHANGELOG_ID = "virtual:changelog";
const RESOLVED_VIRTUAL_CHANGELOG_ID = "\0virtual:changelog";

const RELEASE_HEADING_RE =
  /^#{2,3}\s+(?:\[v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]\([^)]*\)|v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?))\s+\((\d{4}-\d{2}-\d{2})\)\s*$/;
const SECTION_HEADING_RE = /^###\s+(.+?)\s*$/;
const BULLET_LINE_RE = /^\s*[*-]\s+(.+?)\s*$/;
const COMMIT_LINK_RE = new RegExp(
  `(?:\\(\\[(${COMMIT_SHA_PATTERN})\\]\\([^)]*\\)\\)|\\[(${COMMIT_SHA_PATTERN})\\]\\([^)]*\\))`,
  "i",
);
const COMMIT_LINK_PARENS_STRIP_RE = new RegExp(`\\s*\\(\\[${COMMIT_SHA_PATTERN}\\]\\([^)]*\\)\\)`, "gi");
const COMMIT_LINK_TRAILING_STRIP_RE = new RegExp(`\\s+\\[${COMMIT_SHA_PATTERN}\\]\\([^)]*\\)\\s*$`, "gi");
const PR_REF_RE = /(?:\(\[#(\d+)\]\([^)]*\)\)|\[#(\d+)\]\([^)]*\)|\(#(\d+)\))/;
const MARKDOWN_LINK_RE = /!?\[([^\]]*)\]\((?:[^()\s]|\([^()\s]*\))*\)/g;

function stripMarkdownLinks(input: string): string {
  let prev = input;
  for (let i = 0; i < 5; i++) {
    const next = prev.replace(MARKDOWN_LINK_RE, "$1");
    if (next === prev) break;
    prev = next;
  }
  return prev;
}

function parseBulletLine(rawBullet: string): ChangelogItem | null {
  const prMatch = PR_REF_RE.exec(rawBullet);
  const parsedPr = Number.parseInt(prMatch?.[1] ?? prMatch?.[2] ?? prMatch?.[3] ?? "0", 10);
  const pr = parsedPr > 0 ? parsedPr : undefined;

  const shaMatch = COMMIT_LINK_RE.exec(rawBullet);
  const sha = (shaMatch?.[1] ?? shaMatch?.[2])?.toLowerCase();

  let text = rawBullet
    .replace(COMMIT_LINK_PARENS_STRIP_RE, "")
    .replace(COMMIT_LINK_TRAILING_STRIP_RE, "")
    .replace(/\s*\(\[#\d+\]\([^)]*\)\)/g, "")
    .replace(/\s*\(#\d+\)/g, "");

  text = stripMarkdownLinks(text)
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CHANGELOG_MAX_ITEM_TEXT_LENGTH)
    .trim();

  if (text.length === 0) {
    return null;
  }

  const item: ChangelogItem = { text };
  if (pr !== undefined) item.pr = pr;
  if (sha !== undefined) item.sha = sha;
  return item;
}

export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let currentEntry: ChangelogEntry | null = null;
  let currentSection: ChangelogSection | null = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const releaseMatch = RELEASE_HEADING_RE.exec(rawLine);
    if (releaseMatch) {
      const version = releaseMatch[1] ?? releaseMatch[2];
      const date = releaseMatch[3];
      if (version && date) {
        currentEntry = { version, date, sections: [] };
        entries.push(currentEntry);
        currentSection = null;
      }
      continue;
    }

    if (!currentEntry) continue;

    const sectionMatch = SECTION_HEADING_RE.exec(rawLine);
    if (sectionMatch) {
      const title = stripMarkdownLinks(sectionMatch[1])
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, CHANGELOG_MAX_SECTION_TITLE_LENGTH)
        .trim();
      if (title.length > 0) {
        const existing = currentEntry.sections.find((s) => s.title === title);
        if (existing) {
          currentSection = existing;
        } else {
          currentSection = { title, items: [] };
          currentEntry.sections.push(currentSection);
        }
      }
      continue;
    }

    const bulletMatch = BULLET_LINE_RE.exec(rawLine);
    if (bulletMatch) {
      const item = parseBulletLine(bulletMatch[1]);
      if (!item) continue;
      if (!currentSection) {
        currentSection = { title: "Changes", items: [] };
        currentEntry.sections.push(currentSection);
      }
      currentSection.items.push(item);
    }
  }

  for (const entry of entries) {
    entry.sections = entry.sections.filter((s) => s.items.length > 0);
  }
  const cleaned = entries.slice(0, CHANGELOG_MAX_ENTRIES);

  return z.parse(ChangelogSchema, cleaned);
}

export function resolveGitSha(): string {
  const envSha = process.env.GITHUB_SHA?.trim();
  let rawSha: string;
  if (envSha) {
    rawSha = envSha;
  } else {
    try {
      rawSha = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      rawSha = "dev";
    }
  }
  if (!HEX_SHA_RE.test(rawSha)) {
    return "dev";
  }
  return rawSha.toLowerCase().slice(0, BUILD_SHA_LENGTH);
}

export function resolvePackageVersion(): string {
  const pkgPath = resolve(process.cwd(), "package.json");
  const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
  return typeof raw.version === "string" && raw.version.trim() !== ""
    ? raw.version.trim()
    : "0.0.0";
}

/**
 * JSON with object keys, and JSON Schema `required` lists, in a fixed order, so reordering a
 * schema's keys does not change the output.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (key, v: unknown) => {
    if (key === "required" && Array.isArray(v)) return (v as string[]).toSorted();
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return v;
  });
}

/**
 * Fingerprint of what the persisted config and view-state blobs may contain. A tab running an
 * older layout compares it with the deployed one to learn that a newer deployment stores data
 * it can't safely read or write. It hashes:
 *  - the JSON Schema of both schemas (`io: "input"`, the stored side): keys, types, enums,
 *    patterns, array limits and defaults;
 *  - `PERSISTED_LIMITS` and `TRACKED_USER_AVATAR_PREFIX`, the rules enforced by `.refine()`
 *    checks that JSON Schema cannot express.
 * Comments, formatting, helper code and key order don't affect it. A `.refine()` predicate that
 * changes without changing one of those values is not detected, which is why every refine limit
 * must live in `PERSISTED_LIMITS` (a unit test fails when a new refine appears).
 */
export function computeSchemaFingerprint(): string {
  const payload = {
    config: z.toJSONSchema(ConfigSchema, { unrepresentable: "any", io: "input" }),
    view: z.toJSONSchema(ViewStateSchema, { unrepresentable: "any", io: "input" }),
    limits: PERSISTED_LIMITS,
    trackedUserAvatarPrefix: TRACKED_USER_AVATAR_PREFIX,
  };
  return createHash("sha256").update(stableStringify(payload)).digest("hex").slice(0, BUILD_SHA_LENGTH);
}

export function resolveBuildMetadata(): BuildInfo {
  return {
    version: resolvePackageVersion(),
    sha: resolveGitSha(),
    builtAt: new Date().toISOString(),
    schemaFp: computeSchemaFingerprint(),
  };
}

export function buildMeta(): Plugin[] {
  const { version, sha, builtAt, schemaFp } = resolveBuildMetadata();

  return [
    {
      name: "github-tracker:build-meta-define",
      config() {
        return {
          define: {
            __APP_VERSION__: JSON.stringify(version),
            __GIT_SHA__: JSON.stringify(sha),
            __SCHEMA_FP__: JSON.stringify(schemaFp),
          },
        };
      },
    },
    {
      name: "github-tracker:build-meta-emit",
      applyToEnvironment(environment) {
        return environment.name === "client";
      },
      resolveId(id) {
        if (id === VIRTUAL_CHANGELOG_ID) {
          return RESOLVED_VIRTUAL_CHANGELOG_ID;
        }
        return null;
      },
      load(id) {
        if (id !== RESOLVED_VIRTUAL_CHANGELOG_ID) {
          return null;
        }
        const changelogPath = resolve(process.cwd(), "CHANGELOG.md");
        this.addWatchFile(changelogPath);
        if (!existsSync(changelogPath)) {
          return "export default [];";
        }
        const raw = readFileSync(changelogPath, "utf8");
        const entries = parseChangelog(raw);
        return `export default ${JSON.stringify(entries)};`;
      },
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "version.json",
          source: JSON.stringify({ version, sha, builtAt, schemaFp }),
        });
      },
    },
  ];
}

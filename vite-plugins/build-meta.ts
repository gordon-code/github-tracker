import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import * as z from "zod/mini";
import {
  ChangelogSchema,
  type ChangelogEntry,
  type ChangelogItem,
  type ChangelogSection,
} from "../src/shared/changelog-schema";

const HEX_SHA_RE = /^[0-9a-f]{7,40}$/i;
const VIRTUAL_CHANGELOG_ID = "virtual:changelog";
const RESOLVED_VIRTUAL_CHANGELOG_ID = "\0virtual:changelog";
const MAX_CHANGELOG_ENTRIES = 20;
const MAX_ITEM_TEXT_LENGTH = 300;
const MAX_SECTION_TITLE_LENGTH = 100;

const RELEASE_HEADING_RE =
  /^#{2,3}\s+(?:\[v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]\([^)]*\)|v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?))\s+\((\d{4}-\d{2}-\d{2})\)\s*$/;
const SECTION_HEADING_RE = /^###\s+(.+?)\s*$/;
const BULLET_LINE_RE = /^\s*[*-]\s+(.+?)\s*$/;
const COMMIT_LINK_RE = /(?:\(\[([0-9a-f]{7,40})\]\([^)]*\)\)|\[([0-9a-f]{7,40})\]\([^)]*\))/i;
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
  let pr: number | undefined;
  const prMatch = PR_REF_RE.exec(rawBullet);
  if (prMatch) {
    const rawPr = prMatch[1] ?? prMatch[2] ?? prMatch[3];
    if (rawPr) {
      const parsedPr = Number.parseInt(rawPr, 10);
      if (Number.isInteger(parsedPr) && parsedPr > 0) {
        pr = parsedPr;
      }
    }
  }

  let sha: string | undefined;
  const shaMatch = COMMIT_LINK_RE.exec(rawBullet);
  if (shaMatch) {
    const rawSha = shaMatch[1] ?? shaMatch[2];
    if (rawSha && HEX_SHA_RE.test(rawSha)) {
      sha = rawSha.toLowerCase();
    }
  }

  let text = rawBullet
    .replace(/\s*\(\[[0-9a-f]{7,40}\]\([^)]*\)\)/gi, "")
    .replace(/\s+\[[0-9a-f]{7,40}\]\([^)]*\)\s*$/gi, "")
    .replace(/\s*\(\[#\d+\]\([^)]*\)\)/g, "")
    .replace(/\s*\(#\d+\)/g, "");

  text = stripMarkdownLinks(text)
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ITEM_TEXT_LENGTH)
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
        .slice(0, MAX_SECTION_TITLE_LENGTH)
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
  const cleaned = entries.slice(0, MAX_CHANGELOG_ENTRIES);

  return z.parse(ChangelogSchema, cleaned);
}

export interface BuildMetadata {
  version: string;
  sha: string;
  builtAt: string;
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
  return rawSha.toLowerCase().slice(0, 12);
}

export function resolvePackageVersion(): string {
  const pkgPath = resolve(process.cwd(), "package.json");
  const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
  return typeof raw.version === "string" && raw.version.trim() !== ""
    ? raw.version.trim()
    : "0.0.0";
}

export function resolveBuildMetadata(): BuildMetadata {
  return {
    version: resolvePackageVersion(),
    sha: resolveGitSha(),
    builtAt: new Date().toISOString(),
  };
}

export function buildMeta(): Plugin[] {
  const { version, sha, builtAt } = resolveBuildMetadata();

  return [
    {
      name: "github-tracker:build-meta-define",
      config() {
        return {
          define: {
            __APP_VERSION__: JSON.stringify(version),
            __GIT_SHA__: JSON.stringify(sha),
            __BUILD_TIME__: JSON.stringify(builtAt),
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
        if (typeof this.addWatchFile === "function") {
          this.addWatchFile(changelogPath);
        }
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
          source: JSON.stringify({ version, sha, builtAt }),
        });
      },
    },
  ];
}

import { createSignal } from "solid-js";
import { z } from "zod";
import { pushNotification } from "../lib/errors";
import { onAuthCleared } from "../stores/auth";
import { onApiRequest, type ApiRequestInfo } from "./github";

// ── Types ─────────────────────────────────────────────────────────────────────

const API_CALL_SOURCES = [
  "lightSearch", "heavyBackfill", "forkCheck", "globalUserSearch", "unfilteredSearch",
  "upstreamDiscovery", "workflowRuns", "hotPRStatus", "hotRunStatus", "notifications",
  "validateUser", "fetchOrgs", "fetchRepos", "rateLimitCheck", "graphql", "rest",
] as const;

export type ApiCallSource = (typeof API_CALL_SOURCES)[number];

const API_POOLS = ["graphql", "core"] as const;

export type ApiPool = (typeof API_POOLS)[number];

export const SOURCE_LABELS: Record<ApiCallSource, string> = {
  lightSearch: "Light Search",
  heavyBackfill: "PR Backfill",
  forkCheck: "Fork Check",
  globalUserSearch: "Tracked User Search",
  unfilteredSearch: "Unfiltered Search",
  upstreamDiscovery: "Upstream Discovery",
  workflowRuns: "Workflow Runs",
  hotPRStatus: "Hot PR Status",
  hotRunStatus: "Hot Run Status",
  notifications: "Notifications",
  validateUser: "Validate User",
  fetchOrgs: "Fetch Orgs",
  fetchRepos: "Fetch Repos",
  rateLimitCheck: "Rate Limit Check",
  graphql: "GraphQL (other)",
  rest: "REST (other)",
};

export interface ApiCallRecord {
  source: ApiCallSource;
  pool: ApiPool;
  count: number;
  lastCalledAt: number;
}

export interface ApiUsageData {
  records: Record<string, ApiCallRecord>;
  resetAt: number | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const USAGE_STORAGE_KEY = "github-tracker:api-usage";

// ── Zod schemas ───────────────────────────────────────────────────────────────

const ApiCallRecordSchema = z.object({
  source: z.enum(API_CALL_SOURCES),
  pool: z.enum(API_POOLS),
  count: z.number(),
  lastCalledAt: z.number(),
});

const ApiUsageDataSchema = z.object({
  records: z.record(z.string(), ApiCallRecordSchema),
  resetAt: z.number().nullable(),
});

// ── Persistence ───────────────────────────────────────────────────────────────

export function loadUsageData(): ApiUsageData {
  try {
    const raw = localStorage.getItem?.(USAGE_STORAGE_KEY);
    if (raw === null || raw === undefined) return { records: {}, resetAt: null };
    const parsed = JSON.parse(raw) as unknown;
    const result = ApiUsageDataSchema.safeParse(parsed);
    if (result.success) return result.data;
    return { records: {}, resetAt: null };
  } catch {
    return { records: {}, resetAt: null };
  }
}

function _writeToStorage(): void {
  try {
    localStorage.setItem?.(USAGE_STORAGE_KEY, JSON.stringify(_usageData));
  } catch {
    pushNotification("localStorage:api-usage", "API usage write failed — storage may be full", "warning");
  }
}

export function flushUsageData(): void {
  _writeToStorage();
  _setVersion((v) => v + 1);
}

export function resetUsageData(): void {
  _usageData.records = {};
  // Preserve current resetAt so the next window's reset time is still tracked
  _writeToStorage();
  _setVersion((v) => v + 1);
}

export function clearUsageData(): void {
  // Cancel any pending flush debounce timer before removing localStorage
  if (_flushTimer !== null) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  localStorage.removeItem?.(USAGE_STORAGE_KEY);
  _usageData = { records: {}, resetAt: null };
  _setVersion((v) => v + 1);
}

export function checkAndResetIfExpired(): void {
  if (_usageData.resetAt !== null && Date.now() > _usageData.resetAt) {
    _usageData.records = {};
    _usageData.resetAt = null;
    _writeToStorage();
    _setVersion((v) => v + 1);
  }
}

// ── Debounced flush ───────────────────────────────────────────────────────────

let _flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (_flushTimer !== null) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    flushUsageData();
  }, 500);
}

// ── Module-level state ────────────────────────────────────────────────────────

// Initialize from localStorage at import time (same pattern as auth.ts token)
let _usageData: ApiUsageData = loadUsageData();

// Version signal drives reactivity for Settings page display
const [_version, _setVersion] = createSignal(0);

// ── Auth cleanup registration ─────────────────────────────────────────────────

// Mirror poll.ts line 94: onAuthCleared(resetPollState)
onAuthCleared(clearUsageData);

// ── Tracking ──────────────────────────────────────────────────────────────────

export function trackApiCall(source: ApiCallSource, pool: ApiPool, count = 1): void {
  const key = `${source}:${pool}`;
  const existing = _usageData.records[key];
  if (existing) {
    existing.count += count;
    existing.lastCalledAt = Date.now();
  } else {
    _usageData.records[key] = { source, pool, count, lastCalledAt: Date.now() };
  }
  // Do NOT increment _version here — batch the version bump with the flush debounce
  // to prevent rapid re-renders during poll cycles when trackApiCall fires dozens of times.
  scheduleFlush();
}

// ── Reactive accessors ────────────────────────────────────────────────────────

export function getUsageSnapshot(): ApiCallRecord[] {
  // Read _version() first to establish reactive dependency
  _version();
  return Object.values(_usageData.records).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.lastCalledAt - a.lastCalledAt;
  });
}

export function getUsageResetAt(): number | null {
  // Read _version() first to establish reactive dependency
  _version();
  return _usageData.resetAt;
}

export function updateResetAt(resetAt: number): void {
  if (!Number.isFinite(resetAt) || resetAt <= 0) return;
  const current = _usageData.resetAt;
  const next = current === null ? resetAt : Math.max(current, resetAt);
  if (next === current) return;
  _usageData.resetAt = next;
  _setVersion((v) => v + 1);
}

// ── Automatic tracking via Octokit hook ──────────────────────────────────────

// Order matters: more specific patterns must come before general ones.
// /^\/user$/ uses $ to avoid shadowing /user/orgs and /user/repos.
// /actions/runs/\d+$ must precede /actions/runs/ (specific before general).
const REST_SOURCE_PATTERNS: Array<[RegExp, ApiCallSource]> = [
  [/^\/notifications/, "notifications"],
  [/^\/users\/[^/]+$/, "validateUser"],
  [/^\/user$/, "fetchOrgs"],
  [/^\/user\/orgs/, "fetchOrgs"],
  [/^\/orgs\/[^/]+\/repos/, "fetchRepos"],
  [/^\/user\/repos/, "fetchRepos"],
  [/^\/repos\/[^/]+\/[^/]+\/actions\/runs\/\d+$/, "hotRunStatus"],
  [/^\/repos\/[^/]+\/[^/]+\/actions\/runs/, "workflowRuns"],
  [/^\/rate_limit/, "rateLimitCheck"],
];

const API_CALL_SOURCE_SET = new Set<string>(API_CALL_SOURCES);

export function deriveSource(info: ApiRequestInfo): ApiCallSource {
  if (info.isGraphql) {
    return info.apiSource && API_CALL_SOURCE_SET.has(info.apiSource)
      ? (info.apiSource as ApiCallSource)
      : "graphql";
  }
  for (const [pattern, source] of REST_SOURCE_PATTERNS) {
    if (pattern.test(info.url)) return source;
  }
  return "rest";
}

// Register at module scope — intercepts every Octokit request automatically
onApiRequest((info) => {
  const source = deriveSource(info);
  const pool: ApiPool = info.isGraphql ? "graphql" : "core";
  trackApiCall(source, pool);
  // Both pools tracked — Math.max keeps latest; may delay reset of the earlier pool's records
  if (info.resetEpochMs !== null) updateResetAt(info.resetEpochMs);
});

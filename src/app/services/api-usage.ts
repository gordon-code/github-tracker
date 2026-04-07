import { createSignal } from "solid-js";
import { z } from "zod";
import { pushNotification } from "../lib/errors.js";
import { onAuthCleared } from "../stores/auth.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ApiCallSource =
  | "lightSearch"
  | "heavyBackfill"
  | "forkCheck"
  | "globalUserSearch"
  | "unfilteredSearch"
  | "upstreamDiscovery"
  | "workflowRuns"
  | "hotPRStatus"
  | "hotRunStatus"
  | "notifications"
  | "validateUser"
  | "fetchOrgs"
  | "fetchRepos"
  | "rateLimitCheck";

export type ApiPool = "graphql" | "core";

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
  source: z.string(),
  pool: z.string(),
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
    if (result.success) return result.data as ApiUsageData;
    return { records: {}, resetAt: null };
  } catch {
    return { records: {}, resetAt: null };
  }
}

export function flushUsageData(): void {
  try {
    localStorage.setItem?.(USAGE_STORAGE_KEY, JSON.stringify(_usageData));
  } catch {
    pushNotification("localStorage:api-usage", "API usage write failed — storage may be full", "warning");
  }
  _setVersion((v) => v + 1);
}

export function resetUsageData(): void {
  _usageData.records = {};
  // Preserve current resetAt so the next window's reset time is still tracked
  try {
    localStorage.setItem?.(USAGE_STORAGE_KEY, JSON.stringify(_usageData));
  } catch {
    pushNotification("localStorage:api-usage", "API usage write failed — storage may be full", "warning");
  }
  _setVersion((v) => v + 1);
}

export function clearUsageData(): void {
  // Cancel any pending flush debounce timer before removing localStorage (SDR-012)
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
    resetUsageData();
    _usageData.resetAt = null;
    // Write immediately so the null resetAt persists (prevents redundant re-reset on page reload)
    try {
      localStorage.setItem?.(USAGE_STORAGE_KEY, JSON.stringify(_usageData));
    } catch {
      // Non-fatal — next flush will retry
    }
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
  const current = _usageData.resetAt;
  _usageData.resetAt = current === null ? resetAt : Math.max(current, resetAt);
  _setVersion((v) => v + 1);
}

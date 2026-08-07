import { createSignal } from "solid-js";
import { z } from "zod";
import { cachedFetch } from "../stores/cache";
import { dismissNotificationBySource, pushNotification } from "../lib/errors";

// ── Types ─────────────────────────────────────────────────────────────────────

export type GitHubStatusSeverity = "none" | "minor" | "major" | "critical";

export interface GitHubStatusIncident {
  id: string;
  name: string;
  latestUpdateBody: string;
  affectedComponents: string[];
}

export interface GitHubStatusSummary {
  severity: GitHubStatusSeverity;
  incidents: GitHubStatusIncident[];
  fetchedAt: Date;
}

// Minimal raw-API shapes actually consumed — not the full Statuspage schema.
// `impact`/`shortlink` are present on the live API but intentionally dropped:
// neither is consumed anywhere in this feature (no per-incident deep link, no
// in-app incident history). Types are derived from the Zod schemas below so
// validation and typing can never drift apart.
const RawComponentSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
});

const RawIncidentSchema = z.object({
  id: z.string(),
  name: z.string(),
  incident_updates: z.array(z.object({ body: z.string() })),
  components: z.array(RawComponentSchema),
});

const RawSummaryResponseSchema = z.object({
  components: z.array(RawComponentSchema),
  incidents: z.array(RawIncidentSchema),
});

type RawComponent = z.infer<typeof RawComponentSchema>;
type RawSummaryResponse = z.infer<typeof RawSummaryResponseSchema>;

// Exact component names as returned by the live API, verified 2026-08-07 via
// `curl https://www.githubstatus.com/api/v2/summary.json`. Component names are
// Statuspage-admin-configurable free text with no stability guarantee from
// GitHub/Atlassian — if GitHub renames a tracked component (e.g. "Actions" →
// "GitHub Actions"), TRACKED_COMPONENT_NAMES.has(c.name) silently stops matching
// it with no error, no test failure, and no user-visible signal beyond an
// incorrectly-green badge during a real outage. Guarded by
// tests/services/github-status.smoke.test.ts (live network, not part of `pnpm test`).
export const TRACKED_COMPONENT_NAMES = new Set([
  "Actions",
  "API Requests",
  "Git Operations",
  "Issues",
  "Pull Requests",
]);

// Note: unlike poll.ts's resetPollState()/events.ts's resetEventsState(), this
// module deliberately does not hook into onAuthCleared. GitHub's own status is a
// global fact, not scoped to the authenticated user — it should persist across a
// logout/login (or a switch between users on the same browser) exactly as-is.

// ── Severity mapping and blending ────────────────────────────────────────────

const COMPONENT_STATUS_SEVERITY: Record<string, GitHubStatusSeverity> = {
  operational: "none",
  degraded_performance: "minor",
  partial_outage: "major",
  major_outage: "critical",
};
const SEVERITY_RANK: Record<GitHubStatusSeverity, number> = { none: 0, minor: 1, major: 2, critical: 3 };

// [ASSUMPTION: unrecognized component status strings default to "none" severity
// rather than throwing — treats unknown future Statuspage status values as
// non-blocking rather than failing the whole badge]
function blendSeverity(components: RawComponent[]): GitHubStatusSeverity {
  return components.reduce<GitHubStatusSeverity>((worst, c) => {
    const s = COMPONENT_STATUS_SEVERITY[c.status] ?? "none";
    return SEVERITY_RANK[s] > SEVERITY_RANK[worst] ? s : worst;
  }, "none");
}

// ── Notification state and transition tracking ───────────────────────────────

const NOTIFICATION_SOURCE = "github-status";
const NOTIFICATION_SOURCE_RESOLVED = "github-status-resolved";
let _previousIncidents = new Map<string, string>(); // id -> name, across cycles

// ── parseSummary / notifyTransitions ─────────────────────────────────────────

function severityToNotificationLevel(s: GitHubStatusSeverity): "warning" | "error" {
  return s === "critical" || s === "major" ? "error" : "warning";
}

// Incident update bodies are HTML per Statuspage's schema (confirmed live: contains
// literal `<br />` tags). Strip to plain text here so the badge component can render
// via plain JSX text interpolation (Security Flags item 2) without leaking literal
// tags in the UI.
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .trim();
}

// Pure: parses the raw API response and blends severity. No side effects, not
// exported — matches this codebase's established convention of never exporting
// internal parse/transform functions purely for direct unit testing (see
// src/app/services/api.ts's processIssueNode/mapCheckStatus/buildRepoQualifiers).
// Tested indirectly via fetchGitHubStatus.
function parseSummary(raw: RawSummaryResponse): GitHubStatusSummary {
  const trackedComponents = raw.components.filter((c) => TRACKED_COMPONENT_NAMES.has(c.name));
  const severity = blendSeverity(trackedComponents);

  const relevantIncidents: GitHubStatusIncident[] = raw.incidents.flatMap((inc) => {
    const affected = inc.components.filter((c) => TRACKED_COMPONENT_NAMES.has(c.name));
    if (affected.length === 0) return [];
    return [{
      id: inc.id,
      name: inc.name,
      latestUpdateBody: stripHtml(inc.incident_updates[0]?.body ?? ""),
      affectedComponents: affected.map((c) => c.name),
    }];
  });

  return { severity, incidents: relevantIncidents, fetchedAt: new Date() };
}

// Side-effecting: consumes a parsed summary and dispatches notification
// transitions. Mirrors the detectNewItems() (pure) / dispatchNotifications()
// (side-effecting) split already established in src/app/lib/notifications.ts.
//
// Both pushNotification calls pass retryable=false — an outage announcement is
// not a failed/retryable operation. Message text is just the incident name(s),
// not prefixed with "GitHub status: " — NotificationDrawer.tsx/ToastContainer.tsx
// already render `{source}: {message}`, so a message-level prefix would duplicate
// the "github-status" source label already shown.
//
// [ASSUMPTION: concurrent distinct incidents are blended into one "github-status"
// notification/badge state rather than tracked individually — matches the
// single-blended-badge UI decision, avoids a list of independent toasts for a
// rare edge case]
function notifyTransitions(summary: GitHubStatusSummary): void {
  const currentIncidents = new Map(summary.incidents.map((i) => [i.id, i.name]));

  if (summary.incidents.length > 0) {
    const names = summary.incidents.map((i) => i.name).join(", ");
    pushNotification(NOTIFICATION_SOURCE, names, severityToNotificationLevel(summary.severity), false);
  } else {
    dismissNotificationBySource(NOTIFICATION_SOURCE);
  }

  const resolvedNames = [..._previousIncidents.entries()]
    .filter(([id]) => !currentIncidents.has(id))
    .map(([, name]) => name);
  if (resolvedNames.length > 0) {
    pushNotification(NOTIFICATION_SOURCE_RESOLVED, resolvedNames.join(", "), "info", false);
  }

  _previousIncidents = currentIncidents;
}

// ── fetchGitHubStatus — network call via cachedFetch, signal ────────────────

const STATUS_API_URL = "https://www.githubstatus.com/api/v2/summary.json";
const CACHE_KEY = "github-status:summary";

const [_githubStatus, _setGitHubStatus] = createSignal<GitHubStatusSummary | null>(null);
export function getGitHubStatus(): GitHubStatusSummary | null {
  return _githubStatus();
}

let _fetchInProgress = false;

export async function fetchGitHubStatus(): Promise<void> {
  if (_fetchInProgress) return; // in-flight guard — avoid pile-up if refreshInterval is very short/0 or the endpoint is slow to respond
  _fetchInProgress = true;
  try {
    const { data } = await cachedFetch(CACHE_KEY, async (headers) => {
      const reqHeaders: Record<string, string> = {};
      if (headers.etag) reqHeaders["If-None-Match"] = headers.etag;
      const res = await fetch(STATUS_API_URL, {
        headers: reqHeaders,
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 304) {
        return { data: null, etag: headers.etag, lastModified: headers.lastModified, status: 304 };
      }
      const json = await res.json();
      return { data: json, etag: res.headers.get("ETag"), lastModified: res.headers.get("Last-Modified"), status: res.status };
    });

    // Validate the raw shape before parsing — catches API drift (e.g. a field
    // renamed/removed upstream) as a distinct, loud log message instead of an
    // unexplained TypeError deep inside parseSummary. Treated the same as any
    // other fetch failure: no throw, dismiss any active incident notification.
    const validated = RawSummaryResponseSchema.safeParse(data);
    if (!validated.success) {
      console.warn("[github-status] response schema drift — validation failed:", validated.error);
      dismissNotificationBySource(NOTIFICATION_SOURCE);
      return;
    }

    const summary = parseSummary(validated.data);
    notifyTransitions(summary);
    _setGitHubStatus(summary);
  } catch (err) {
    console.warn("[github-status] fetch failed:", err instanceof Error ? err.message : String(err));
    // Best-effort, ancillary external signal — deliberately no pushError, don't
    // pollute the notification center with transient network blips for a
    // non-critical feature the user can't act on anyway. Still DO dismiss any
    // active "github-status" incident notification: notifyTransitions() owns
    // this notification's entire lifecycle end-to-end, and poll.ts deliberately
    // excludes github-status from poll-level reconciliation (POLL_MANAGED_SOURCES),
    // so if this fetch starts failing persistently while an incident notification
    // is showing, nothing else would ever clear it. A single fetch failure just
    // means "we don't currently know," not "the incident is still ongoing," so
    // unconditional dismiss-on-any-failure is preferred over tracking a
    // consecutive-failure counter (simpler, guarantees no stuck state).
    dismissNotificationBySource(NOTIFICATION_SOURCE);
  } finally {
    _fetchInProgress = false;
  }
}

// Test-only reset — mirrors resetPollState() (poll.ts), resetNotificationState()
// (lib/errors.ts), resetEventsState() (services/events.ts). Deliberately NOT
// wired to onAuthCleared (see note above: GitHub status is global, not
// user-scoped, and must survive logout/login).
export function resetGitHubStatusState(): void {
  _previousIncidents = new Map();
  _setGitHubStatus(null);
  _fetchInProgress = false;
}

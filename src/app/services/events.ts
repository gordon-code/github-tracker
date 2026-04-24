import { getClient } from "./github";
import { onAuthCleared } from "../stores/auth";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GitHubEvent {
  id: string;
  type: string;
  actor: { id: number; login: string };
  repo: { id: number; name: string }; // "owner/repo" format
  payload: Record<string, unknown>;
  created_at: string;
}

export interface RepoEventSummary {
  repoFullName: string;       // "owner/repo"
  eventTypes: Set<string>;    // which event types fired
  hasIssueActivity: boolean;
  hasPRActivity: boolean;
  hasWorkflowActivity: boolean; // PushEvent can trigger workflows
  latestEventAt: string;      // ISO timestamp of newest event
}

// PullRequestReviewEvent presence on the user events endpoint is unverified;
// included optimistically — it's harmless if absent.
export const ACTIONABLE_EVENT_TYPES = [
  "IssuesEvent",
  "IssueCommentEvent",
  "PullRequestEvent",
  "PullRequestReviewEvent",
  "PullRequestReviewCommentEvent",
  "PushEvent",
] as const;

// ── Module-level ETag state ───────────────────────────────────────────────────

let _eventsETag: string | null = null;
let _lastEventId: string | null = null;

// ── Auth cleanup ──────────────────────────────────────────────────────────────

export function resetEventsState(): void {
  _eventsETag = null;
  _lastEventId = null;
}

// Self-contained cleanup — same pattern as api-usage.ts onAuthCleared registration
onAuthCleared(resetEventsState);

// ── fetchUserEvents ───────────────────────────────────────────────────────────

type GitHubOctokit = NonNullable<ReturnType<typeof getClient>>;

export async function fetchUserEvents(
  octokit: GitHubOctokit,
  username: string,
): Promise<{ events: GitHubEvent[]; changed: boolean }> {
  // SEC-IMPL-001: guard on non-empty login
  if (!username) {
    return { events: [], changed: false };
  }

  const headers: Record<string, string> = {};
  if (_eventsETag) {
    headers["If-None-Match"] = _eventsETag;
  }

  try {
    const response = await octokit.request("GET /users/{username}/events", {
      username,
      per_page: 100,
      headers,
    });

    // Store ETag for next conditional request
    const etag = (response.headers as Record<string, string>)["etag"];
    if (etag) {
      _eventsETag = etag;
    }

    const allEvents = (response.data as GitHubEvent[]);

    // First call: no ID filter — seed _lastEventId and return all events
    if (_lastEventId === null) {
      if (allEvents.length > 0) {
        _lastEventId = allEvents[0].id; // events are newest-first
      }
      return { events: allEvents, changed: true };
    }

    // Subsequent calls: filter to only events newer than _lastEventId
    // Use numeric comparison — event IDs are numeric strings; lexicographic
    // comparison would break for IDs of different lengths (e.g. "9" > "10").
    const lastIdNum = parseInt(_lastEventId, 10);
    const newEvents = allEvents.filter(
      (e) => parseInt(e.id, 10) > lastIdNum,
    );

    if (newEvents.length > 0) {
      _lastEventId = allEvents[0].id; // newest event is always first
    }

    return { events: newEvents, changed: newEvents.length > 0 };
  } catch (err) {
    // Octokit throws RequestError on 304 — same pattern as hasNotificationChanges()
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { status?: number }).status === 304
    ) {
      return { events: [], changed: false };
    }
    // Silent fallback for all other errors — full refresh handles reconciliation
    console.warn("[events] fetchUserEvents error:", err instanceof Error ? err.message : String(err));
    return { events: [], changed: false };
  }
}

// ── parseRepoEvents ───────────────────────────────────────────────────────────

const ACTIONABLE_SET = new Set<string>(ACTIONABLE_EVENT_TYPES);

export function parseRepoEvents(
  events: GitHubEvent[],
  trackedRepoNames: Set<string>,
): Map<string, RepoEventSummary> {
  const result = new Map<string, RepoEventSummary>();

  // Pre-lowercase the tracked set for case-insensitive comparison
  const trackedLower = new Set<string>();
  for (const name of trackedRepoNames) {
    trackedLower.add(name.toLowerCase());
  }

  for (const event of events) {
    if (!ACTIONABLE_SET.has(event.type)) continue;

    const repoNameLower = event.repo.name.toLowerCase();
    if (!trackedLower.has(repoNameLower)) continue;

    // Use the canonical casing from the event payload
    const repoFullName = event.repo.name;

    let summary = result.get(repoNameLower);
    if (!summary) {
      summary = {
        repoFullName,
        eventTypes: new Set<string>(),
        hasIssueActivity: false,
        hasPRActivity: false,
        hasWorkflowActivity: false,
        latestEventAt: event.created_at,
      };
      result.set(repoNameLower, summary);
    }

    summary.eventTypes.add(event.type);

    if (event.type === "IssuesEvent" || event.type === "IssueCommentEvent") {
      summary.hasIssueActivity = true;
    }
    if (
      event.type === "PullRequestEvent" ||
      event.type === "PullRequestReviewEvent" ||
      event.type === "PullRequestReviewCommentEvent"
    ) {
      summary.hasPRActivity = true;
    }
    if (event.type === "PushEvent") {
      summary.hasWorkflowActivity = true;
    }

    // Track latest timestamp (events are newest-first, but don't assume order)
    if (event.created_at > summary.latestEventAt) {
      summary.latestEventAt = event.created_at;
    }
  }

  return result;
}

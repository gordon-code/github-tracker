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

// ── Module-level state ───────────────────────────────────────────────────────

let _lastEventId: string | null = null;

// ── Auth cleanup ──────────────────────────────────────────────────────────────

export function resetEventsState(): void {
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
  // Empty login would hit the public /users//events endpoint
  if (!username) {
    return { events: [], changed: false };
  }

  try {
    // GitHub docs suggest per_page is capped at 30 for Events API, but empirical
    // testing (2026-05-03) confirmed per_page: 100 returns 100 events successfully.
    const response = await octokit.request("GET /users/{username}/events", {
      username,
      per_page: 100,
    });

    let allEvents = (response.data as GitHubEvent[]);

    // Paginate if page is full — older events on subsequent pages would be
    // permanently missed since _lastEventId advances past them.
    let page = 2;
    let lastPageEvents = allEvents;
    while (lastPageEvents.length === 100 && page <= 3) {
      if (_lastEventId !== null) {
        const threshold = parseInt(_lastEventId, 10);
        if (lastPageEvents.some((e) => parseInt(e.id, 10) <= threshold)) break;
      }
      try {
        const next = await octokit.request("GET /users/{username}/events", {
          username,
          per_page: 100,
          page,
        });
        const nextEvents = (next.data as GitHubEvent[]);
        if (nextEvents.length === 0) break;
        allEvents = [...allEvents, ...nextEvents];
        lastPageEvents = nextEvents;
        page++;
      } catch (err) {
        console.warn(`[events] pagination error on page ${page}:`, err instanceof Error ? err.message : String(err));
        break;
      }
    }

    const maxId = allEvents.reduce(
      (max, e) => Math.max(max, parseInt(e.id, 10)),
      0,
    );

    // First call: seed _lastEventId and return all events
    if (_lastEventId === null) {
      if (maxId > 0) {
        _lastEventId = String(maxId);
      }
      return { events: allEvents, changed: allEvents.length > 0 };
    }

    // Subsequent calls: filter to only events newer than _lastEventId
    const lastIdNum = parseInt(_lastEventId, 10);
    const newEvents = allEvents.filter(
      (e) => parseInt(e.id, 10) > lastIdNum,
    );

    if (maxId > lastIdNum) {
      _lastEventId = String(maxId);
    }

    return { events: newEvents, changed: newEvents.length > 0 };
  } catch (err) {
    const status =
      err && typeof err === "object" && "status" in err
        ? (err as { status: number }).status
        : null;
    if (status === 304) {
      console.warn("[events] unexpected 304 from proxy/CDN; events suppressed this cycle");
    } else {
      console.warn("[events] fetchUserEvents error:", err instanceof Error ? err.message : String(err));
    }
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

  for (const event of events) {
    if (!ACTIONABLE_SET.has(event.type)) continue;

    const repoNameLower = event.repo.name.toLowerCase();
    if (!trackedRepoNames.has(repoNameLower)) continue;

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

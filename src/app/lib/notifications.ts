import type { Config } from "../stores/config";
import type { DashboardData } from "../services/poll";
import type { Issue, PullRequest, WorkflowRun } from "../services/api";
import { isSafeGitHubUrl } from "./url";

// ── Permission management ─────────────────────────────────────────────────────

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!("Notification" in window)) return "denied";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  return Notification.requestPermission();
}

export function canNotify(config: Config): boolean {
  return (
    "Notification" in window &&
    Notification.permission === "granted" &&
    config.notifications.enabled
  );
}

// ── New item detection ────────────────────────────────────────────────────────

export const SEEN_ID_CAP = 20_000;

// In-memory sets of seen IDs — not persisted across page loads
const seenIssueIds = new Set<number>();
const seenPrIds = new Set<number>();
const seenRunIds = new Set<number>();

// True after the first fetch completes — prevents flood on initial load
let initialized = false;

function markIdSeen(set: Set<number>, id: number): void {
  set.delete(id);
  set.add(id);
  if (set.size > SEEN_ID_CAP) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) {
      set.delete(oldest);
    }
  }
}

function collectNewAndMarkSeen<T extends { id: number }>(set: Set<number>, items: T[]): T[] {
  for (const item of items) {
    if (set.has(item.id)) {
      markIdSeen(set, item.id);
    }
  }
  const newItems: T[] = [];
  for (const item of items) {
    if (!set.has(item.id)) {
      newItems.push(item);
      markIdSeen(set, item.id);
    }
  }
  return newItems;
}

export interface NewItems {
  issues: Issue[];
  pullRequests: PullRequest[];
  workflowRuns: WorkflowRun[];
}

export function detectNewItems(current: DashboardData): NewItems {
  if (!initialized) {
    // First fetch: populate seen sets without notifying
    for (const item of current.issues) markIdSeen(seenIssueIds, item.id);
    for (const item of current.pullRequests) markIdSeen(seenPrIds, item.id);
    for (const item of current.workflowRuns) markIdSeen(seenRunIds, item.id);
    initialized = true;
    console.debug(`[notifications] seeded: ${seenIssueIds.size} issues, ${seenPrIds.size} PRs, ${seenRunIds.size} runs`);
    return { issues: [], pullRequests: [], workflowRuns: [] };
  }

  const newIssues = collectNewAndMarkSeen(seenIssueIds, current.issues);
  const newPrs = collectNewAndMarkSeen(seenPrIds, current.pullRequests);
  const newRuns = collectNewAndMarkSeen(seenRunIds, current.workflowRuns);

  console.debug(`[notifications] detected: ${newIssues.length} new issues, ${newPrs.length} new PRs, ${newRuns.length} new runs (seen: ${seenIssueIds.size}/${seenPrIds.size}/${seenRunIds.size})`);
  return { issues: newIssues, pullRequests: newPrs, workflowRuns: newRuns };
}

// Exposed for testing only
export function _resetNotificationState(): void {
  seenIssueIds.clear();
  seenPrIds.clear();
  seenRunIds.clear();
  initialized = false;
}

export function _getSeenSizes(): { issues: number; pullRequests: number; workflowRuns: number } {
  return {
    issues: seenIssueIds.size,
    pullRequests: seenPrIds.size,
    workflowRuns: seenRunIds.size,
  };
}

// ── Notification dispatch ─────────────────────────────────────────────────────

const BATCH_THRESHOLD = 5;

function openUrl(url: string): void {
  if (!isSafeGitHubUrl(url)) return;
  window.focus();
  window.open(url, "_blank", "noopener,noreferrer");
}

function fireNotification(
  title: string,
  body: string,
  tag: string,
  url?: string
): void {
  try {
    const n = new Notification(title, { body, tag, icon: "/assets/logo-192.png" });
    if (url) {
      const safeUrl = url;
      n.onclick = () => openUrl(safeUrl);
    }
  } catch (err) {
    console.debug("[notifications] Notification constructor failed:", err);
  }
}

export function dispatchNotifications(newItems: NewItems, config: Config): void {
  if (!canNotify(config)) {
    console.debug("[notifications] dispatch skipped — canNotify=false", {
      notificationApi: "Notification" in window,
      permission: "Notification" in window ? Notification.permission : "N/A",
      enabled: config.notifications.enabled,
    });
    return;
  }
  console.debug("[notifications] dispatching", { issues: newItems.issues.length, prs: newItems.pullRequests.length, runs: newItems.workflowRuns.length });

  const { issues, pullRequests, workflowRuns } = newItems;
  const notifCfg = config.notifications;

  // Issues
  if (notifCfg.issues && issues.length > 0) {
    if (issues.length > BATCH_THRESHOLD) {
      fireNotification(
        `${issues.length} new issues`,
        issues.map((i) => i.title).slice(0, 3).join(", ") + "…",
        "issues-batch"
      );
    } else {
      for (const issue of issues) {
        fireNotification(
          `New issue: ${issue.title}`,
          issue.repoFullName,
          `issue-${issue.id}`,
          issue.htmlUrl
        );
      }
    }
  }

  // Pull Requests
  if (notifCfg.pullRequests && pullRequests.length > 0) {
    if (pullRequests.length > BATCH_THRESHOLD) {
      fireNotification(
        `${pullRequests.length} new pull requests`,
        pullRequests.map((p) => p.title).slice(0, 3).join(", ") + "…",
        "prs-batch"
      );
    } else {
      for (const pr of pullRequests) {
        fireNotification(
          `New PR: ${pr.title}`,
          pr.repoFullName,
          `pr-${pr.id}`,
          pr.htmlUrl
        );
      }
    }
  }

  // Workflow Runs
  if (notifCfg.workflowRuns && workflowRuns.length > 0) {
    if (workflowRuns.length > BATCH_THRESHOLD) {
      fireNotification(
        `${workflowRuns.length} new workflow runs`,
        workflowRuns.map((r) => r.name).slice(0, 3).join(", ") + "…",
        "runs-batch"
      );
    } else {
      for (const run of workflowRuns) {
        fireNotification(
          `New run: ${run.name}`,
          `${run.repoFullName} — ${run.status}`,
          `run-${run.id}`,
          run.htmlUrl
        );
      }
    }
  }
}

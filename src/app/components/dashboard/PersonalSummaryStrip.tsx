import { createMemo, For, Show } from "solid-js";
import type { Issue, PullRequest, WorkflowRun } from "../../services/api";
import type { TabId } from "../layout/TabBar";

interface SummaryCount {
  label: string;
  count: number;
  tab: TabId;
}

interface PersonalSummaryStripProps {
  issues: Issue[];
  pullRequests: PullRequest[];
  workflowRuns: WorkflowRun[];
  userLogin: string;
  onTabChange: (tab: TabId) => void;
}

export default function PersonalSummaryStrip(props: PersonalSummaryStripProps) {
  // Single-pass over issues to count assigned
  const issueCounts = createMemo(() => {
    const login = props.userLogin.toLowerCase();
    if (!login) return { assignedIssues: 0 };
    let assignedIssues = 0;
    for (const i of props.issues) {
      if (i.assigneeLogins.some((a) => a.toLowerCase() === login)) assignedIssues++;
    }
    return { assignedIssues };
  });

  // Single-pass over PRs to count awaiting review, ready to merge, and blocked
  const prCounts = createMemo(() => {
    const login = props.userLogin.toLowerCase();
    if (!login) return { prsAwaitingReview: 0, prsReadyToMerge: 0, prsBlocked: 0 };
    let prsAwaitingReview = 0;
    let prsReadyToMerge = 0;
    let prsBlocked = 0;
    for (const pr of props.pullRequests) {
      const isAuthor = pr.userLogin.toLowerCase() === login;
      if (
        pr.enriched !== false &&
        pr.reviewDecision === "REVIEW_REQUIRED" &&
        pr.reviewerLogins.some((r) => r.toLowerCase() === login)
      ) {
        prsAwaitingReview++;
      }
      if (
        isAuthor &&
        !pr.draft &&
        pr.checkStatus === "success" &&
        (pr.reviewDecision === "APPROVED" || pr.reviewDecision === null)
      ) {
        prsReadyToMerge++;
      }
      if (
        isAuthor &&
        !pr.draft &&
        (pr.checkStatus === "failure" || pr.checkStatus === "conflict")
      ) {
        prsBlocked++;
      }
    }
    return { prsAwaitingReview, prsReadyToMerge, prsBlocked };
  });

  const runningActions = createMemo(() =>
    props.workflowRuns.filter((r) => r.status === "in_progress").length
  );

  const summaryItems = createMemo(() => {
    const { assignedIssues } = issueCounts();
    const { prsAwaitingReview, prsReadyToMerge, prsBlocked } = prCounts();
    const running = runningActions();
    const items: SummaryCount[] = [];
    if (assignedIssues > 0) items.push({ label: "assigned", count: assignedIssues, tab: "issues" });
    if (prsAwaitingReview > 0) items.push({ label: "awaiting review", count: prsAwaitingReview, tab: "pullRequests" });
    if (prsReadyToMerge > 0) items.push({ label: "ready to merge", count: prsReadyToMerge, tab: "pullRequests" });
    if (prsBlocked > 0) items.push({ label: "blocked", count: prsBlocked, tab: "pullRequests" });
    if (running > 0) items.push({ label: "running", count: running, tab: "actions" });
    return items;
  });

  return (
    <Show when={summaryItems().length > 0}>
      <div class="flex items-center gap-3 px-4 py-1.5 text-xs border-b border-base-300 bg-base-100">
        <For each={summaryItems()}>
          {(item, idx) => (
            <>
              <Show when={idx() > 0}>
                <span class="text-base-content/30">·</span>
              </Show>
              <button
                type="button"
                class="hover:text-primary transition-colors cursor-pointer"
                onClick={() => props.onTabChange(item.tab)}
              >
                <span class="font-medium">{item.count}</span>{" "}{item.label}
              </button>
            </>
          )}
        </For>
      </div>
    </Show>
  );
}

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
  const assignedIssues = createMemo(() => {
    const login = props.userLogin.toLowerCase();
    if (!login) return 0;
    return props.issues.filter((i) =>
      i.assigneeLogins.some((a) => a.toLowerCase() === login)
    ).length;
  });

  const prsAwaitingReview = createMemo(() => {
    const login = props.userLogin.toLowerCase();
    if (!login) return 0;
    return props.pullRequests.filter(
      (pr) =>
        pr.enriched !== false &&
        pr.reviewDecision === "REVIEW_REQUIRED" &&
        pr.reviewerLogins.some((r) => r.toLowerCase() === login)
    ).length;
  });

  const prsReadyToMerge = createMemo(() => {
    const login = props.userLogin.toLowerCase();
    if (!login) return 0;
    return props.pullRequests.filter(
      (pr) =>
        pr.userLogin.toLowerCase() === login &&
        !pr.draft &&
        pr.checkStatus === "success" &&
        (pr.reviewDecision === "APPROVED" || pr.reviewDecision === null)
    ).length;
  });

  const prsBlocked = createMemo(() => {
    const login = props.userLogin.toLowerCase();
    if (!login) return 0;
    return props.pullRequests.filter(
      (pr) =>
        pr.userLogin.toLowerCase() === login &&
        !pr.draft &&
        (pr.checkStatus === "failure" || pr.checkStatus === "conflict")
    ).length;
  });

  const runningActions = createMemo(() =>
    props.workflowRuns.filter((r) => r.status === "in_progress").length
  );

  const summaryItems = createMemo(() => {
    const items: SummaryCount[] = [];
    if (assignedIssues() > 0) items.push({ label: "assigned", count: assignedIssues(), tab: "issues" });
    if (prsAwaitingReview() > 0) items.push({ label: "awaiting review", count: prsAwaitingReview(), tab: "pullRequests" });
    if (prsReadyToMerge() > 0) items.push({ label: "ready to merge", count: prsReadyToMerge(), tab: "pullRequests" });
    if (prsBlocked() > 0) items.push({ label: "blocked", count: prsBlocked(), tab: "pullRequests" });
    if (runningActions() > 0) items.push({ label: "running", count: runningActions(), tab: "actions" });
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

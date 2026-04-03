import { createMemo, For, Show } from "solid-js";
import type { Issue, PullRequest, WorkflowRun } from "../../services/api";
import type { TabId } from "../layout/TabBar";
import { viewState, resetAllTabFilters, setTabFilter } from "../../stores/view";

interface SummaryCount {
  label: string;
  count: number;
  tab: TabId;
  applyFilters: () => void;
}

interface PersonalSummaryStripProps {
  issues: Issue[];
  pullRequests: PullRequest[];
  workflowRuns: WorkflowRun[];
  userLogin: string;
  onTabChange: (tab: TabId) => void;
}

export default function PersonalSummaryStrip(props: PersonalSummaryStripProps) {
  const ignoredIds = createMemo(() => {
    const ids = new Set<string>();
    for (const item of viewState.ignoredItems) ids.add(item.id);
    return ids;
  });

  // Single-pass over issues to count assigned (excludes ignored)
  const issueCounts = createMemo(() => {
    const login = props.userLogin.toLowerCase();
    if (!login) return { assignedIssues: 0 };
    const ignored = ignoredIds();
    let assignedIssues = 0;
    for (const i of props.issues) {
      if (ignored.has(String(i.id))) continue;
      if (i.assigneeLogins.some((a) => a.toLowerCase() === login)) assignedIssues++;
    }
    return { assignedIssues };
  });

  // Single-pass over PRs to count awaiting review, ready to merge, and blocked (excludes ignored)
  const prCounts = createMemo(() => {
    const login = props.userLogin.toLowerCase();
    if (!login) return { prsAwaitingReview: 0, prsReadyToMerge: 0, prsBlocked: 0 };
    const ignored = ignoredIds();
    let prsAwaitingReview = 0;
    let prsReadyToMerge = 0;
    let prsBlocked = 0;
    for (const pr of props.pullRequests) {
      if (ignored.has(String(pr.id))) continue;
      const isAuthor = pr.userLogin.toLowerCase() === login;
      if (
        !isAuthor &&
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

  const runningActions = createMemo(() => {
    const ignored = ignoredIds();
    return props.workflowRuns.filter((r) => !ignored.has(String(r.id)) && r.status === "in_progress").length;
  });

  const summaryItems = createMemo(() => {
    const { assignedIssues } = issueCounts();
    const { prsAwaitingReview, prsReadyToMerge, prsBlocked } = prCounts();
    const running = runningActions();
    const items: SummaryCount[] = [];
    // Summary counts from unfiltered data — set scope=all so the filtered view
    // matches. The specific filters (role, checkStatus) already ensure relevance.
    if (assignedIssues > 0) items.push({
      label: assignedIssues === 1 ? "issue assigned" : "issues assigned",
      count: assignedIssues,
      tab: "issues",
      applyFilters: () => {
        resetAllTabFilters("issues");
        setTabFilter("issues", "scope", "all");
        setTabFilter("issues", "role", "assignee");
      },
    });
    if (prsAwaitingReview > 0) items.push({
      label: prsAwaitingReview === 1 ? "PR awaiting review" : "PRs awaiting review",
      count: prsAwaitingReview,
      tab: "pullRequests",
      applyFilters: () => {
        resetAllTabFilters("pullRequests");
        setTabFilter("pullRequests", "scope", "all");
        setTabFilter("pullRequests", "role", "reviewer");
        setTabFilter("pullRequests", "reviewDecision", "REVIEW_REQUIRED");
      },
    });
    if (prsReadyToMerge > 0) items.push({
      label: prsReadyToMerge === 1 ? "PR ready to merge" : "PRs ready to merge",
      count: prsReadyToMerge,
      tab: "pullRequests",
      applyFilters: () => {
        resetAllTabFilters("pullRequests");
        setTabFilter("pullRequests", "scope", "all");
        setTabFilter("pullRequests", "role", "author");
        setTabFilter("pullRequests", "draft", "ready");
        setTabFilter("pullRequests", "checkStatus", "success");
      },
    });
    if (prsBlocked > 0) items.push({
      label: prsBlocked === 1 ? "PR blocked" : "PRs blocked",
      count: prsBlocked,
      tab: "pullRequests",
      applyFilters: () => {
        resetAllTabFilters("pullRequests");
        setTabFilter("pullRequests", "scope", "all");
        setTabFilter("pullRequests", "role", "author");
        setTabFilter("pullRequests", "draft", "ready");
        setTabFilter("pullRequests", "checkStatus", "blocked");
      },
    });
    if (running > 0) items.push({
      label: running === 1 ? "action running" : "actions running",
      count: running,
      tab: "actions",
      applyFilters: () => {
        resetAllTabFilters("actions");
        setTabFilter("actions", "conclusion", "running");
      },
    });
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
                onClick={() => { item.applyFilters(); props.onTabChange(item.tab); }}
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

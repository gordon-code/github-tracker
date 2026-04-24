import { createMemo, For, Show } from "solid-js";
import { produce } from "solid-js/store";
import type { Issue, PullRequest, WorkflowRun } from "../../services/api";
import type { TabId } from "../layout/TabBar";
import { viewState, setViewState, IssueFiltersSchema, PullRequestFiltersSchema, ActionsFiltersSchema } from "../../stores/view";
import { InfoTooltip } from "../shared/Tooltip";

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
    const ids = new Set<number>();
    for (const item of viewState.ignoredItems) ids.add(item.id);
    return ids;
  });

  // Single-pass over issues to count assigned (excludes ignored + Dep Dashboard)
  const issueCounts = createMemo(() => {
    const login = props.userLogin.toLowerCase();
    if (!login) return { assignedIssues: 0 };
    const ignored = ignoredIds();
    let assignedIssues = 0;
    for (const i of props.issues) {
      if (ignored.has(i.id)) continue;
      if (i.state !== "OPEN") continue;
      if (viewState.hideDepDashboard && i.title === "Dependency Dashboard") continue;
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
      if (ignored.has(pr.id)) continue;
      if (pr.state !== "OPEN") continue;
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
    return props.workflowRuns.filter((r) => !ignored.has(r.id) && r.status === "in_progress").length;
  });

  const summaryItems = createMemo(() => {
    const { assignedIssues } = issueCounts();
    const { prsAwaitingReview, prsReadyToMerge, prsBlocked } = prCounts();
    const running = runningActions();
    const items: SummaryCount[] = [];
    // ── Count-to-filter contract ──
    // Counts are computed from unfiltered data (ignoring scope, globalFilter, showPrRuns).
    // Click filters set scope=all so tabs don't hide items the count included.
    // Known approximations (single-value filter system cannot express these):
    //   - "ready to merge": uses composite reviewDecision=mergeable (APPROVED||null)
    //   - "awaiting review": count excludes self-authored PRs (!isAuthor), but
    //     role=reviewer filter includes them if user is both author+reviewer (rare)
    //   - globalFilter (org/repo) is NOT applied here — counts are persistent
    //     awareness across all repos, matching the tab badge behavior
    //   - "running": count includes all in_progress runs; click enables showPrRuns
    //     so PR-triggered runs are visible in the tab
    if (assignedIssues > 0) items.push({
      label: assignedIssues === 1 ? "issue assigned" : "issues assigned",
      count: assignedIssues,
      tab: "issues",
      applyFilters: () => {
        setViewState(produce(draft => {
          draft.tabFilters.issues = { ...IssueFiltersSchema.parse({}), scope: "all", role: "assignee" };
        }));
      },
    });
    if (prsAwaitingReview > 0) items.push({
      label: prsAwaitingReview === 1 ? "PR awaiting review" : "PRs awaiting review",
      count: prsAwaitingReview,
      tab: "pullRequests",
      applyFilters: () => {
        setViewState(produce(draft => {
          draft.tabFilters.pullRequests = { ...PullRequestFiltersSchema.parse({}), scope: "all", role: "reviewer", reviewDecision: "REVIEW_REQUIRED" };
        }));
      },
    });
    if (prsReadyToMerge > 0) items.push({
      label: prsReadyToMerge === 1 ? "PR ready to merge" : "PRs ready to merge",
      count: prsReadyToMerge,
      tab: "pullRequests",
      applyFilters: () => {
        setViewState(produce(draft => {
          draft.tabFilters.pullRequests = { ...PullRequestFiltersSchema.parse({}), scope: "all", role: "author", draft: "ready", checkStatus: "success", reviewDecision: "mergeable" };
        }));
      },
    });
    if (prsBlocked > 0) items.push({
      label: prsBlocked === 1 ? "PR blocked" : "PRs blocked",
      count: prsBlocked,
      tab: "pullRequests",
      applyFilters: () => {
        setViewState(produce(draft => {
          draft.tabFilters.pullRequests = { ...PullRequestFiltersSchema.parse({}), scope: "all", role: "author", draft: "ready", checkStatus: "blocked" };
        }));
      },
    });
    if (running > 0) items.push({
      label: running === 1 ? "action running" : "actions running",
      count: running,
      tab: "actions",
      applyFilters: () => {
        setViewState(produce(draft => {
          draft.tabFilters.actions = { ...ActionsFiltersSchema.parse({}), conclusion: "running" };
          draft.showPrRuns = true;
        }));
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
        <InfoTooltip content="Click any count to view those items." placement="bottom" />
      </div>
    </Show>
  );
}

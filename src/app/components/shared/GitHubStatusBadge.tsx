import { Show, For, createMemo, createSignal } from "solid-js";
import { Popover } from "@kobalte/core/popover";
import { Tooltip } from "./Tooltip";
import { getGitHubStatus, type GitHubStatusSeverity } from "../../services/github-status";

const SEVERITY_CONFIG: Record<GitHubStatusSeverity, { bg: string; label: string; pulse: boolean }> = {
  none: { bg: "bg-success", label: "All systems operational", pulse: false },
  minor: { bg: "bg-warning", label: "Minor GitHub service disruption", pulse: false },
  major: { bg: "bg-orange-500", label: "Major GitHub service outage", pulse: true },
  critical: { bg: "bg-red-500", label: "Critical GitHub service outage", pulse: true },
};

export default function GitHubStatusBadge() {
  const status = createMemo(() => getGitHubStatus());
  const cfg = createMemo(() => {
    const s = status();
    return s !== null
      ? SEVERITY_CONFIG[s.severity]
      : { bg: "bg-base-content/20", label: "Checking GitHub status…", pulse: false };
  });
  const statusSummaryRow = () => (
    <div class="flex items-center gap-2">
      <span class={`inline-flex rounded-full w-2 h-2 ${cfg().bg}`} />
      <span>{cfg().label}</span>
    </div>
  );
  const incidentList = createMemo(() => {
    const s = status();
    return s && s.incidents.length > 0 ? s.incidents : null;
  });
  const [popoverOpen, setPopoverOpen] = createSignal(false);

  return (
    <Popover placement="bottom-end" onOpenChange={setPopoverOpen}>
      <Tooltip content={cfg().label} placement="bottom" forceClosed={popoverOpen()}>
        <Popover.Trigger as="button" type="button" class="btn btn-ghost btn-sm shrink-0" aria-label={cfg().label}>
          <span class="relative inline-flex items-center justify-center w-3 h-3">
            <Show when={cfg().pulse}>
              <span class={`absolute inline-flex h-full w-full rounded-full ${cfg().bg} animate-slow-pulse`} />
            </Show>
            <span class={`relative inline-flex rounded-full w-2 h-2 ${cfg().bg}`} />
          </span>
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content aria-label="GitHub status" class="bg-base-100 border border-base-300 rounded-lg shadow-lg z-50 p-3 w-72 text-sm">
          <Show when={incidentList()} fallback={statusSummaryRow()}>
            {(list) => (
              <ul class="flex flex-col gap-3">
                <For each={list()}>
                  {(incident) => (
                    <li>
                      <div class="font-medium">{incident.name}</div>
                      <div class="text-xs text-base-content/60">Affects: {incident.affectedComponents.join(", ")}</div>
                      <Show when={incident.latestUpdateBody}>
                        <p class="mt-1 text-xs whitespace-pre-line">{incident.latestUpdateBody}</p>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            )}
          </Show>
          <a href="https://www.githubstatus.com" target="_blank" rel="noopener noreferrer" class="link link-hover text-xs mt-2 inline-block">
            View githubstatus.com
          </a>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  );
}

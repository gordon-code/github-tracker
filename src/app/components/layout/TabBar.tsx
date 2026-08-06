import { Tabs } from "@kobalte/core/tabs";
import { For, Show } from "solid-js";
import { Tooltip } from "../shared/Tooltip";

export type TabId = string;

export type TabCounts = Record<string, number | undefined>;

interface TabBarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  counts?: TabCounts;
  enableTracking?: boolean;
  enableActions?: boolean;
  enableJira?: boolean;
  enableDependencies?: boolean;
  customTabs?: Array<{ id: string; name: string; isUnscoped?: boolean }>;
  onAddTab?: () => void;
  onEditTab?: (id: string) => void;
}

export default function TabBar(props: TabBarProps) {
  return (
    <Tabs value={props.activeTab} onChange={(val) => props.onTabChange(val)}>
      <div class="border-b border-base-300">
        <div class="max-w-6xl mx-auto w-full px-4">
          <div class="flex items-center">
            <Tabs.List class="tabs tabs-border flex-1 overflow-x-auto" aria-label="Dashboard tabs">
              <Tabs.Trigger value="issues" class="tab compact:tab-sm data-[selected]:tab-active">
                Issues
                <Show when={props.counts?.issues !== undefined}>
                  <span class="badge badge-sm badge-neutral ml-1">{props.counts?.issues}</span>
                </Show>
              </Tabs.Trigger>
              <Tabs.Trigger value="pullRequests" class="tab compact:tab-sm data-[selected]:tab-active">
                Pull Requests
                <Show when={props.counts?.pullRequests !== undefined}>
                  <span class="badge badge-sm badge-neutral ml-1">{props.counts?.pullRequests}</span>
                </Show>
              </Tabs.Trigger>
              <Show when={props.enableDependencies}>
                <Tabs.Trigger value="dependencies" class="tab compact:tab-sm data-[selected]:tab-active">
                  Dependencies
                  <Show when={props.counts?.dependencies !== undefined}>
                    <span class="badge badge-sm badge-neutral ml-1">{props.counts?.dependencies}</span>
                  </Show>
                </Tabs.Trigger>
              </Show>
              <Show when={props.enableActions !== false}>
                <Tabs.Trigger value="actions" class="tab compact:tab-sm data-[selected]:tab-active">
                  Actions
                  <Show when={props.counts?.actions !== undefined}>
                    <span class="badge badge-sm badge-neutral ml-1">{props.counts?.actions}</span>
                  </Show>
                </Tabs.Trigger>
              </Show>
              <Show when={props.enableTracking}>
                <Tabs.Trigger value="tracked" class="tab compact:tab-sm data-[selected]:tab-active">
                  Tracked
                  <Show when={props.counts?.tracked !== undefined}>
                    <span class="badge badge-sm badge-neutral ml-1">{props.counts?.tracked}</span>
                  </Show>
                </Tabs.Trigger>
              </Show>
              <Show when={props.enableJira}>
                <Tabs.Trigger value="jiraAssigned" class="tab compact:tab-sm data-[selected]:tab-active">
                  Jira Assigned
                  <Show when={props.counts?.jiraAssigned !== undefined}>
                    <span class="badge badge-sm badge-neutral ml-1">{props.counts?.jiraAssigned}</span>
                  </Show>
                </Tabs.Trigger>
              </Show>
              {/* Wrapper <div> around custom tab triggers is safe for Kobalte keyboard nav:
                  Kobalte uses querySelector('[data-key="..."]') for focus management and a
                  Collection-based delegate for Arrow Left/Right — neither depend on direct children. */}
              <For each={props.customTabs}>
                {(tab) => (
                  <div class="relative group/tab flex items-center">
                    <Tabs.Trigger value={tab.id} class="tab compact:tab-sm data-[selected]:tab-active">
                      <Show when={tab.isUnscoped}>
                        <Tooltip content="Unscoped — this tab won't match any repos until you add scope">
                          <svg class="h-3.5 w-3.5 text-warning mr-1" fill="currentColor" viewBox="0 0 20 20" aria-label="Unscoped tab" role="img">
                            <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l6.28 11.163c.75 1.333-.213 2.987-1.742 2.987H3.72c-1.53 0-2.492-1.654-1.743-2.987L8.257 3.1zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
                          </svg>
                        </Tooltip>
                      </Show>
                      {tab.name}
                      <Show when={props.counts?.[tab.id] !== undefined}>
                        <span class="badge badge-sm badge-neutral ml-1">{props.counts?.[tab.id]}</span>
                      </Show>
                    </Tabs.Trigger>
                    <Show when={props.onEditTab}>
                      <Tooltip content="Edit tab">
                        <button
                          type="button"
                          class="absolute -right-1 top-0 opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100 text-base-content/40 hover:text-base-content hidden md:inline-flex"
                          aria-label={`Edit ${tab.name}`}
                          onClick={() => props.onEditTab?.(tab.id)}
                        >
                          <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                      </Tooltip>
                    </Show>
                  </div>
                )}
              </For>
            </Tabs.List>
            <Show when={props.onAddTab}>
              <Tooltip content="Add custom tab">
                <button
                  type="button"
                  class="btn btn-ghost btn-sm text-base-content/50 hover:text-base-content ml-1 hidden md:inline-flex"
                  aria-label="Add custom tab"
                  onClick={() => props.onAddTab?.()}
                >
                  +
                </button>
              </Tooltip>
            </Show>
          </div>
        </div>
      </div>
    </Tabs>
  );
}

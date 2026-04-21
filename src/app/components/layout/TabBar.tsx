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
  customTabs?: Array<{ id: string; name: string }>;
  onAddTab?: () => void;
  onEditTab?: (id: string) => void;
}

export default function TabBar(props: TabBarProps) {
  return (
    <Tabs value={props.activeTab} onChange={(val) => props.onTabChange(val)}>
      <div class="border-b border-base-300">
        <div class="max-w-6xl mx-auto w-full px-4">
          <div class="flex items-center">
            <Tabs.List class="tabs tabs-border flex-1 overflow-x-auto">
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
              <Tabs.Trigger value="actions" class="tab compact:tab-sm data-[selected]:tab-active">
                Actions
                <Show when={props.counts?.actions !== undefined}>
                  <span class="badge badge-sm badge-neutral ml-1">{props.counts?.actions}</span>
                </Show>
              </Tabs.Trigger>
              <Show when={props.enableTracking}>
                <Tabs.Trigger value="tracked" class="tab compact:tab-sm data-[selected]:tab-active">
                  Tracked
                  <Show when={props.counts?.tracked !== undefined}>
                    <span class="badge badge-sm badge-neutral ml-1">{props.counts?.tracked}</span>
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
                      {tab.name}
                      <Show when={props.counts?.[tab.id] !== undefined}>
                        <span class="badge badge-sm badge-neutral ml-1">{props.counts?.[tab.id]}</span>
                      </Show>
                    </Tabs.Trigger>
                    <Show when={props.onEditTab}>
                      <Tooltip content={`Edit ${tab.name}`}>
                        <button
                          type="button"
                          class="absolute -right-1 top-0 opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100 text-base-content/40 hover:text-base-content hidden md:inline-flex"
                          aria-label={`Edit ${tab.name}`}
                          onClick={() => props.onEditTab?.(tab.id)}
                        >
                          <svg class="h-3 w-3" fill="none" stroke="currentColor" stroke-width={2} viewBox="0 0 24 24" aria-hidden="true">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.573-1.066z" />
                            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
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

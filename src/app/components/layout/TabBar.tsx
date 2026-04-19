import { Tabs } from "@kobalte/core/tabs";
import { For, Show } from "solid-js";

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
                <Show when={props.counts?.["issues"] !== undefined}>
                  <span class="badge badge-sm badge-neutral ml-1">{props.counts?.["issues"]}</span>
                </Show>
              </Tabs.Trigger>
              <Tabs.Trigger value="pullRequests" class="tab compact:tab-sm data-[selected]:tab-active">
                Pull Requests
                <Show when={props.counts?.["pullRequests"] !== undefined}>
                  <span class="badge badge-sm badge-neutral ml-1">{props.counts?.["pullRequests"]}</span>
                </Show>
              </Tabs.Trigger>
              <Tabs.Trigger value="actions" class="tab compact:tab-sm data-[selected]:tab-active">
                Actions
                <Show when={props.counts?.["actions"] !== undefined}>
                  <span class="badge badge-sm badge-neutral ml-1">{props.counts?.["actions"]}</span>
                </Show>
              </Tabs.Trigger>
              <Show when={props.enableTracking}>
                <Tabs.Trigger value="tracked" class="tab compact:tab-sm data-[selected]:tab-active">
                  Tracked
                  <Show when={props.counts?.["tracked"] !== undefined}>
                    <span class="badge badge-sm badge-neutral ml-1">{props.counts?.["tracked"]}</span>
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
                      <button
                        type="button"
                        class="absolute -right-1 top-0 opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100 text-base-content/40 hover:text-base-content text-xs hidden md:inline-flex"
                        aria-label={`Edit ${tab.name}`}
                        onClick={() => props.onEditTab?.(tab.id)}
                      >
                        ✎
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </Tabs.List>
            <Show when={props.onAddTab}>
              <button
                type="button"
                class="btn btn-ghost btn-sm text-base-content/50 hover:text-base-content ml-1 hidden md:inline-flex"
                aria-label="Add custom tab"
                onClick={() => props.onAddTab?.()}
              >
                +
              </button>
            </Show>
          </div>
        </div>
      </div>
    </Tabs>
  );
}

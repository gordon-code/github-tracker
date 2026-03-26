import { Tabs } from "@kobalte/core/tabs";
import { Show } from "solid-js";

export type TabId = "issues" | "pullRequests" | "actions";

export interface TabCounts {
  issues?: number;
  pullRequests?: number;
  actions?: number;
}

interface TabBarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  counts?: TabCounts;
}

export default function TabBar(props: TabBarProps) {
  return (
    <Tabs value={props.activeTab} onChange={(val) => props.onTabChange(val as TabId)}>
      <div class="border-b border-base-300">
        <div class="max-w-6xl mx-auto w-full px-4">
          <Tabs.List class="tabs tabs-border">
            <Tabs.Trigger value="issues" class="tab data-[selected]:tab-active">
              Issues
              <Show when={props.counts?.issues !== undefined}>
                <span class="badge badge-sm ml-1">{props.counts?.issues}</span>
              </Show>
            </Tabs.Trigger>
            <Tabs.Trigger value="pullRequests" class="tab data-[selected]:tab-active">
              Pull Requests
              <Show when={props.counts?.pullRequests !== undefined}>
                <span class="badge badge-sm ml-1">{props.counts?.pullRequests}</span>
              </Show>
            </Tabs.Trigger>
            <Tabs.Trigger value="actions" class="tab data-[selected]:tab-active">
              Actions
              <Show when={props.counts?.actions !== undefined}>
                <span class="badge badge-sm ml-1">{props.counts?.actions}</span>
              </Show>
            </Tabs.Trigger>
          </Tabs.List>
        </div>
      </div>
    </Tabs>
  );
}

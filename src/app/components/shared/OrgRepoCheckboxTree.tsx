import { createMemo, For, Show } from "solid-js";
import type { RepoRef } from "../../services/api";

export interface OrgRepoCheckboxTreeProps {
  availableOrgs: string[];
  availableRepos: RepoRef[];
  checkedOrgs: Set<string>;
  checkedRepos: Set<string>;
  onToggleOrg: (org: string) => void;
  onToggleRepo: (repoFullName: string) => void;
  emptyMessage?: string;
}

export default function OrgRepoCheckboxTree(props: OrgRepoCheckboxTreeProps) {
  return (
    <Show
      when={props.availableOrgs.length > 0}
      fallback={<p class="text-xs text-base-content/40">{props.emptyMessage ?? "No orgs available."}</p>}
    >
      <For each={props.availableOrgs}>
        {(org) => {
          const orgRepos = createMemo(() => props.availableRepos.filter((r) => r.owner === org));
          return (
            <div>
              <label class="flex items-center gap-2 cursor-pointer py-1">
                <input
                  type="checkbox"
                  class="checkbox checkbox-sm checkbox-primary"
                  checked={props.checkedOrgs.has(org)}
                  onChange={() => props.onToggleOrg(org)}
                />
                <span class="text-sm font-semibold">{org}</span>
              </label>
              <Show when={orgRepos().length > 0}>
                <div class="ml-6 space-y-0.5">
                  <For each={orgRepos()}>
                    {(repo) => (
                      <label class="flex items-center gap-2 cursor-pointer py-0.5">
                        <input
                          type="checkbox"
                          class="checkbox checkbox-xs checkbox-primary"
                          checked={props.checkedRepos.has(repo.fullName) || props.checkedOrgs.has(org)}
                          disabled={props.checkedOrgs.has(org)}
                          onChange={() => props.onToggleRepo(repo.fullName)}
                        />
                        <span class="text-xs text-base-content/70">{repo.name}</span>
                      </label>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          );
        }}
      </For>
    </Show>
  );
}

import { createSignal, createMemo, For, Show } from "solid-js";
import { config, removeCustomTab, reorderCustomTab } from "../../stores/config";
import type { CustomTab } from "../../stores/config";
import type { RepoRef } from "../../services/api";
import CustomTabModal from "../shared/CustomTabModal";
import { Tooltip } from "../shared/Tooltip";
import { formatScopeSummary } from "../../lib/format";

function baseTypeLabel(baseType: CustomTab["baseType"]): string {
  if (baseType === "issues") return "Issues";
  if (baseType === "pullRequests") return "PRs";
  return "Actions";
}

function baseTypeBadgeClass(baseType: CustomTab["baseType"]): string {
  if (baseType === "issues") return "badge-info";
  if (baseType === "pullRequests") return "badge-success";
  return "badge-warning";
}

interface CustomTabsSectionProps {
  availableOrgs: string[];
  availableRepos: RepoRef[];
}

export default function CustomTabsSection(props: CustomTabsSectionProps) {
  const [showModal, setShowModal] = createSignal(false);
  const [editingTabId, setEditingTabId] = createSignal<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = createSignal<string | null>(null);

  const editingTab = createMemo(() => {
    const id = editingTabId();
    if (!id) return undefined;
    return config.customTabs.find((t) => t.id === id);
  });

  const atCap = createMemo(() => config.customTabs.length >= 10);

  function handleEdit(id: string) {
    setEditingTabId(id);
    setShowModal(true);
  }

  function handleDeleteConfirm(id: string) {
    removeCustomTab(id);
    setConfirmingDeleteId(null);
  }

  function handleClose() {
    setShowModal(false);
    setEditingTabId(null);
  }

  return (
    <div class="flex flex-col gap-3 px-4 py-3">
      <Show
        when={config.customTabs.length > 0}
        fallback={
          <p class="text-sm text-base-content/50">
            No custom tabs yet. Use the button below to create one.
          </p>
        }
      >
        <div class="overflow-x-auto">
          <table class="table table-sm">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Scope</th>
                <th class="text-center">Exclusive</th>
                <th class="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              <For each={config.customTabs}>
                {(tab, index) => (
                  <tr>
                    <td class="font-medium truncate max-w-[150px]">{tab.name}</td>
                    <td>
                      <span class={`badge badge-xs ${baseTypeBadgeClass(tab.baseType)}`}>
                        {baseTypeLabel(tab.baseType)}
                      </span>
                    </td>
                    <td class="text-xs text-base-content/70">{formatScopeSummary(tab.orgScope.length, tab.repoScope.length, true)}</td>
                    <td class="text-center">
                      {tab.exclusive ? (
                        <svg class="h-4 w-4 text-success inline" fill="currentColor" viewBox="0 0 20 20" aria-label="Exclusive" role="img">
                          <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                        </svg>
                      ) : (
                        <span class="text-base-content/30" aria-label="Not exclusive">—</span>
                      )}
                    </td>
                    <td>
                      <Show
                        when={confirmingDeleteId() === tab.id}
                        fallback={
                          <div class="flex items-center justify-end gap-1">
                            <Tooltip content={index() === 0 ? "Already at top" : "Move up"}>
                              <button
                                type="button"
                                class="btn btn-ghost btn-xs btn-circle"
                                aria-label={`Move "${tab.name}" up`}
                                disabled={index() === 0}
                                onClick={() => reorderCustomTab(tab.id, "up")}
                              >
                                <svg class="h-3 w-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                                  <path fill-rule="evenodd" d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z" clip-rule="evenodd" />
                                </svg>
                              </button>
                            </Tooltip>
                            <Tooltip content={index() === config.customTabs.length - 1 ? "Already at bottom" : "Move down"}>
                              <button
                                type="button"
                                class="btn btn-ghost btn-xs btn-circle"
                                aria-label={`Move "${tab.name}" down`}
                                disabled={index() === config.customTabs.length - 1}
                                onClick={() => reorderCustomTab(tab.id, "down")}
                              >
                                <svg class="h-3 w-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                                  <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
                                </svg>
                              </button>
                            </Tooltip>
                            <Tooltip content={`Edit "${tab.name}"`}>
                              <button
                                type="button"
                                class="btn btn-ghost btn-xs btn-circle"
                                aria-label={`Edit "${tab.name}"`}
                                onClick={() => handleEdit(tab.id)}
                              >
                                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                              </button>
                            </Tooltip>
                            <Tooltip content={`Delete "${tab.name}"`}>
                              <button
                                type="button"
                                class="btn btn-ghost btn-xs btn-circle text-error hover:bg-error/10"
                                aria-label={`Delete "${tab.name}"`}
                                onClick={() => setConfirmingDeleteId(tab.id)}
                              >
                                <svg class="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                                  <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" />
                                </svg>
                              </button>
                            </Tooltip>
                          </div>
                        }
                      >
                        <div class="flex items-center justify-end gap-1">
                          <span class="text-xs text-error mr-1">Delete?</span>
                          <button
                            type="button"
                            class="btn btn-error btn-xs"
                            aria-label={`Confirm delete "${tab.name}"`}
                            onClick={() => handleDeleteConfirm(tab.id)}
                          >
                            Yes
                          </button>
                          <button
                            type="button"
                            class="btn btn-ghost btn-xs"
                            aria-label="Cancel delete"
                            onClick={() => setConfirmingDeleteId(null)}
                          >
                            No
                          </button>
                        </div>
                      </Show>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      {/* Add button */}
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="btn btn-sm btn-outline"
          disabled={atCap()}
          title={atCap() ? "Maximum 10 custom tabs" : undefined}
          onClick={() => { setEditingTabId(null); setShowModal(true); }}
        >
          Add custom tab
        </button>
        <Show when={atCap()}>
          <span class="text-xs text-base-content/50">Maximum 10 custom tabs</span>
        </Show>
      </div>

      {/* Modal */}
      <CustomTabModal
        open={showModal()}
        onClose={handleClose}
        editingTab={editingTab()}
        availableOrgs={props.availableOrgs}
        availableRepos={props.availableRepos}
      />
    </div>
  );
}

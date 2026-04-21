import { createSignal, createMemo, createEffect, For, Show } from "solid-js";
import { Dialog } from "@kobalte/core/dialog";
import { addCustomTab, updateCustomTab, config } from "../../stores/config";
import type { CustomTab } from "../../stores/config";
import { resetCustomTabFilters } from "../../stores/view";
import type { RepoRef } from "../../services/api";
import { formatScopeSummary } from "../../lib/format";
import {
  scopeFilterGroup,
  issueFilterGroups,
  prFilterGroups,
  actionsFilterGroups,
  type FilterChipGroupDef,
} from "./filterTypes";

interface CustomTabModalProps {
  open: boolean;
  onClose: () => void;
  editingTab?: CustomTab;
  availableOrgs: string[];
  availableRepos: RepoRef[];
}

// Filter groups per base type — scope is included for issues/PRs since custom tabs always show it
const filterGroupsByType: Record<"issues" | "pullRequests" | "actions", FilterChipGroupDef[]> = {
  issues: [scopeFilterGroup, ...issueFilterGroups],
  pullRequests: [scopeFilterGroup, ...prFilterGroups],
  actions: actionsFilterGroups,
};

export default function CustomTabModal(props: CustomTabModalProps) {
  const isEdit = () => !!props.editingTab;

  const [name, setName] = createSignal(props.editingTab?.name ?? "");
  const [baseType, setBaseType] = createSignal<"issues" | "pullRequests" | "actions">(
    props.editingTab?.baseType ?? "issues"
  );
  const [selectedOrgs, setSelectedOrgs] = createSignal<Set<string>>(
    new Set(props.editingTab?.orgScope ?? [])
  );
  const [selectedRepos, setSelectedRepos] = createSignal<Set<string>>(
    new Set((props.editingTab?.repoScope ?? []).map((r) => r.fullName))
  );
  // filterPreset: field → value. Only set keys are stored.
  const [filterPreset, setFilterPreset] = createSignal<Record<string, string>>(
    { ...(props.editingTab?.filterPreset ?? {}) }
  );
  const [exclusive, setExclusive] = createSignal(props.editingTab?.exclusive ?? false);
  const [scopeOpen, setScopeOpen] = createSignal(false);
  const [capError, setCapError] = createSignal(false);

  // Reinitialize form state when the modal opens with a different editingTab.
  // Signals are initialized at mount; without this, switching from "edit tab A" to
  // "edit tab B" (open=false then open=true) would show stale values from tab A.
  createEffect(() => {
    if (!props.open) return;
    const tab = props.editingTab;
    setName(tab?.name ?? "");
    setBaseType(tab?.baseType ?? "issues");
    setSelectedOrgs(new Set(tab?.orgScope ?? []));
    setSelectedRepos(new Set((tab?.repoScope ?? []).map((r) => r.fullName)));
    setFilterPreset({ ...(tab?.filterPreset ?? {}) });
    setExclusive(tab?.exclusive ?? false);
    setScopeOpen(false);
    setCapError(false);
  });

  const nameValid = createMemo(() => name().trim().length > 0 && name().trim().length <= 30);

  // User field group — dynamic, includes tracked user logins
  const userFieldGroup = createMemo((): FilterChipGroupDef => ({
    label: "User",
    field: "user",
    options: [
      { value: "_self", label: "Me" },
      ...config.trackedUsers.map((u) => ({ value: u.login, label: u.login })),
    ],
  }));

  // Filter groups for the active base type, plus user field for issues/PRs
  const activeFilterGroups = createMemo((): FilterChipGroupDef[] => {
    const base = filterGroupsByType[baseType()];
    if (baseType() === "issues" || baseType() === "pullRequests") {
      return [...base, userFieldGroup()];
    }
    return base;
  });

  function toggleOrg(org: string) {
    setSelectedOrgs((prev) => {
      const next = new Set(prev);
      if (next.has(org)) {
        next.delete(org);
        // Also remove repos in this org from repo selection
        setSelectedRepos((prevRepos) => {
          const nextRepos = new Set(prevRepos);
          for (const r of props.availableRepos) {
            if (r.owner === org) nextRepos.delete(r.fullName);
          }
          return nextRepos;
        });
      } else {
        next.add(org);
      }
      return next;
    });
  }

  function toggleRepo(repoFullName: string) {
    setSelectedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoFullName)) {
        next.delete(repoFullName);
      } else {
        next.add(repoFullName);
      }
      return next;
    });
  }

  function handleBaseTypeChange(bt: "issues" | "pullRequests" | "actions") {
    setBaseType(bt);
    // Clear filter preset when base type changes — keys are type-specific
    setFilterPreset({});
  }

  function handlePresetChange(field: string, value: string) {
    setFilterPreset((prev) => {
      const next = { ...prev };
      const group = activeFilterGroups().find((g) => g.field === field);
      const defaultVal = group?.defaultValue ?? "all";
      if (value === defaultVal) {
        // Remove key when set back to default — only store explicit overrides
        delete next[field];
      } else {
        next[field] = value;
      }
      return next;
    });
  }

  function buildRepoScope(): RepoRef[] {
    return props.availableRepos.filter((r) => selectedRepos().has(r.fullName));
  }

  function handleSave() {
    if (!nameValid()) return;
    setCapError(false);

    // Only store keys the user explicitly set (not defaults)
    const preset = { ...filterPreset() };

    const editTab = props.editingTab;
    if (editTab) {
      const prevType = editTab.baseType;
      updateCustomTab(editTab.id, {
        name: name().trim(),
        baseType: baseType(),
        orgScope: [...selectedOrgs()],
        repoScope: buildRepoScope(),
        filterPreset: preset,
        exclusive: exclusive(),
      });
      // If base type changed, clear stale runtime filter state
      if (prevType !== baseType()) {
        resetCustomTabFilters(editTab.id);
      }
    } else {
      if (config.customTabs.length >= 10) {
        setCapError(true);
        return;
      }
      const id = crypto.randomUUID().slice(0, 8);
      addCustomTab({
        id,
        name: name().trim(),
        baseType: baseType(),
        orgScope: [...selectedOrgs()],
        repoScope: buildRepoScope(),
        filterPreset: preset,
        exclusive: exclusive(),
      });
    }
    props.onClose();
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()} modal>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 bg-black/50 z-[70]" />
        <Dialog.Content class="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg bg-base-100 rounded-xl shadow-xl z-[71] flex flex-col max-h-[90vh]">
          <Dialog.Description class="sr-only">
            {isEdit() ? "Edit custom tab settings" : "Create a new custom tab"}
          </Dialog.Description>

          {/* Header */}
          <div class="flex items-center gap-2 px-5 py-4 border-b border-base-300 shrink-0">
            <Dialog.Title class="text-lg font-semibold flex-1">
              {isEdit() ? "Edit Custom Tab" : "New Custom Tab"}
            </Dialog.Title>
            <button
              type="button"
              class="btn btn-ghost btn-sm btn-circle"
              aria-label="Close"
              onClick={props.onClose}
            >
              ✕
            </button>
          </div>

          {/* Scrollable body */}
          <div class="overflow-y-auto flex-1 px-5 py-4 space-y-5">

            {/* Name */}
            <div class="form-control gap-1">
              <label class="label py-0" for="custom-tab-name">
                <span class="label-text font-medium">Name</span>
                <span class="label-text-alt text-base-content/50">{name().length}/30</span>
              </label>
              <input
                id="custom-tab-name"
                type="text"
                class="input input-bordered input-sm w-full"
                placeholder="e.g., My OSAC PRs"
                maxLength={30}
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
              />
            </div>

            {/* Base type */}
            <div class="form-control gap-1">
              <label class="label py-0" for="custom-tab-type">
                <span class="label-text font-medium">Type</span>
              </label>
              <select
                id="custom-tab-type"
                class="select select-bordered select-sm w-full"
                value={baseType()}
                onChange={(e) => handleBaseTypeChange(e.currentTarget.value as "issues" | "pullRequests" | "actions")}
              >
                <option value="issues">Issues</option>
                <option value="pullRequests">Pull Requests</option>
                <option value="actions">Actions</option>
              </select>
            </div>

            {/* Scope section */}
            <div class="border border-base-300 rounded-lg overflow-hidden">
              <button
                type="button"
                class="w-full flex items-center justify-between px-4 py-2 bg-base-200 text-sm font-medium hover:bg-base-300 transition-colors"
                aria-expanded={scopeOpen()}
                aria-controls="custom-tab-scope-panel"
                onClick={() => setScopeOpen((v) => !v)}
              >
                <span>Scope</span>
                <span class="text-base-content/50 text-xs">
                  {formatScopeSummary(selectedOrgs().size, selectedRepos().size)}
                  <span class="ml-2">{scopeOpen() ? "▲" : "▼"}</span>
                </span>
              </button>
              <Show when={scopeOpen()}>
                <div id="custom-tab-scope-panel" class="p-3 space-y-3">
                  <p class="text-xs text-base-content/50">
                    Leave empty to include all repos. Org selection includes all repos in that org.
                  </p>
                  <Show
                    when={props.availableOrgs.length > 0}
                    fallback={<p class="text-xs text-base-content/40">No orgs available.</p>}
                  >
                    <div class="overflow-y-auto max-h-[300px] space-y-3">
                      <For each={props.availableOrgs}>
                        {(org) => {
                          const orgRepos = createMemo(() =>
                            props.availableRepos.filter((r) => r.owner === org)
                          );
                          return (
                            <div>
                              {/* Org header checkbox */}
                              <label class="flex items-center gap-2 cursor-pointer py-1">
                                <input
                                  type="checkbox"
                                  class="checkbox checkbox-sm checkbox-primary"
                                  checked={selectedOrgs().has(org)}
                                  onChange={() => toggleOrg(org)}
                                />
                                <span class="text-sm font-semibold">{org}</span>
                              </label>
                              {/* Repo checkboxes under org */}
                              <Show when={orgRepos().length > 0}>
                                <div class="ml-6 space-y-0.5">
                                  <For each={orgRepos()}>
                                    {(repo) => (
                                      <label class="flex items-center gap-2 cursor-pointer py-0.5">
                                        <input
                                          type="checkbox"
                                          class="checkbox checkbox-xs checkbox-primary"
                                          checked={selectedRepos().has(repo.fullName) || selectedOrgs().has(org)}
                                          disabled={selectedOrgs().has(org)}
                                          onChange={() => toggleRepo(repo.fullName)}
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
                    </div>
                  </Show>
                </div>
              </Show>
            </div>

            {/* Filter preset */}
            <div class="space-y-2">
              <p class="text-sm font-medium">Filter Preset</p>
              <p class="text-xs text-base-content/50">
                Default filters applied when this tab is opened. Users can adjust at runtime.
              </p>
              <div class="space-y-2">
                <For each={activeFilterGroups()}>
                  {(group) => (
                    <div class="flex items-center gap-3">
                      <label class="text-xs text-base-content/70 w-24 shrink-0">{group.label}</label>
                      <select
                        class="select select-bordered select-xs flex-1"
                        aria-label={group.label}
                        value={filterPreset()[group.field] ?? group.defaultValue ?? "all"}
                        onChange={(e) => handlePresetChange(group.field, e.currentTarget.value)}
                      >
                        <Show when={!group.defaultValue}>
                          <option value="all">All (default)</option>
                        </Show>
                        <For each={group.options}>
                          {(opt) => (
                            <option value={opt.value}>
                              {opt.label}{opt.value === group.defaultValue ? " (default)" : ""}
                            </option>
                          )}
                        </For>
                      </select>
                    </div>
                  )}
                </For>
              </div>
            </div>

            {/* Exclusive toggle */}
            <div class="flex items-start gap-3">
              <div class="flex-1">
                <p class="text-sm font-medium">Exclusive</p>
                <p id="custom-tab-exclusive-desc" class="text-xs text-base-content/50 mt-0.5">
                  Own matching items — hide them from all other tabs (except Tracked)
                </p>
              </div>
              <input
                id="custom-tab-exclusive"
                type="checkbox"
                class="toggle toggle-primary mt-0.5"
                checked={exclusive()}
                aria-describedby="custom-tab-exclusive-desc"
                onChange={(e) => setExclusive(e.currentTarget.checked)}
              />
            </div>

            {/* Cap error */}
            <Show when={capError()}>
              <p class="text-sm text-error">Maximum of 10 custom tabs reached.</p>
            </Show>
          </div>

          {/* Footer */}
          <div class="flex items-center justify-end gap-2 px-5 py-4 border-t border-base-300 shrink-0">
            <button type="button" class="btn btn-ghost btn-sm" onClick={props.onClose}>
              Cancel
            </button>
            <button
              type="button"
              class="btn btn-primary btn-sm"
              disabled={!nameValid()}
              onClick={handleSave}
            >
              {isEdit() ? "Save" : "Create"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}

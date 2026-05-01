import { createSignal, createMemo, For, Show, onMount } from "solid-js";
import { type IJiraClient, DEFAULT_FIELDS } from "../../services/jira-client";
import type { JiraFieldMeta } from "../../../shared/jira-types";
import type { JiraCustomField } from "../../../shared/schemas";
import LoadingSpinner from "../shared/LoadingSpinner";

interface JiraFieldPickerProps {
  client: IJiraClient;
  selectedFields: JiraCustomField[];
  onSave: (fields: JiraCustomField[]) => void;
  onCancel: () => void;
}

export default function JiraFieldPicker(props: JiraFieldPickerProps) {
  const [fields, setFields] = createSignal<JiraFieldMeta[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [search, setSearch] = createSignal("");
  const [selected, setSelected] = createSignal<Map<string, JiraCustomField>>(
    new Map(props.selectedFields.map((f) => [f.id, f]))
  );
  const [sampleValues, setSampleValues] = createSignal<Record<string, unknown>>({});

  onMount(async () => {
    try {
      const allFields = await props.client.getFields();
      const defaultFieldIds = new Set(DEFAULT_FIELDS);
      const selectable = allFields.filter((f) => f.custom || !defaultFieldIds.has(f.id));
      setFields(selectable);

      // Best-effort sample value fetch — request all fields (*all) across
      // multiple queries to maximize coverage across projects and issue types.
      const fieldIdSet = new Set(selectable.map((f) => f.id));
      if (fieldIdSet.size > 0) {
        try {
          const queries = [
            "assignee = currentUser() ORDER BY updated DESC",
            "project in projectsWhereUserHasPermission('Browse') ORDER BY updated DESC",
          ];
          const merged: Record<string, unknown> = {};
          for (const jql of queries) {
            if (Object.keys(merged).length >= fieldIdSet.size) break;
            try {
              const result = await props.client.searchJql(jql, { maxResults: 20, fields: ["*all"] });
              for (const issue of result.issues) {
                const fields = issue.fields as Record<string, unknown>;
                for (const id of fieldIdSet) {
                  if (id in merged) continue;
                  if (fields[id] !== undefined && fields[id] !== null) {
                    merged[id] = fields[id];
                  }
                }
              }
            } catch {
              // Individual query failure shouldn't block others
            }
          }
          setSampleValues(merged);
        } catch {
          // Best-effort — don't block the picker
        }
      }
    } catch {
      setError("Failed to load fields. Check your Jira connection.");
    } finally {
      setLoading(false);
    }
  });

  const filtered = createMemo(() => {
    const q = search().toLowerCase();
    const matched = fields().filter((f) => !q || f.name.toLowerCase().includes(q));
    const samples = sampleValues();
    const sel = selected();
    const selOrder = [...sel.keys()];
    return matched.sort((a, b) => {
      const aSel = sel.has(a.id);
      const bSel = sel.has(b.id);
      if (aSel !== bSel) return aSel ? -1 : 1;
      if (aSel && bSel) return selOrder.indexOf(a.id) - selOrder.indexOf(b.id);
      const aHas = samples[a.id] !== null && samples[a.id] !== undefined;
      const bHas = samples[b.id] !== null && samples[b.id] !== undefined;
      if (aHas !== bHas) return aHas ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  });

  const selectedCount = createMemo(() => selected().size);

  function toggleField(field: JiraFieldMeta) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(field.id)) {
        next.delete(field.id);
      } else if (next.size < 10) {
        next.set(field.id, { id: field.id, name: field.name });
      }
      return next;
    });
  }

  function moveField(id: string, direction: "up" | "down") {
    setSelected((prev) => {
      const entries = [...prev.entries()];
      const idx = entries.findIndex(([k]) => k === id);
      if (idx < 0) return prev;
      const swapIdx = direction === "up" ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= entries.length) return prev;
      [entries[idx], entries[swapIdx]] = [entries[swapIdx], entries[idx]];
      return new Map(entries);
    });
  }

  function handleSave() {
    props.onSave([...selected().values()]);
  }

  function extractLabel(obj: Record<string, unknown>): string | null {
    for (const key of ["displayName", "name", "value", "label"] as const) {
      if (typeof obj[key] === "string") return obj[key];
    }
    return null;
  }

  function previewText(fieldId: string): string {
    const val = sampleValues()[fieldId];
    if (val === null || val === undefined) return "—";
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      const s = String(val);
      return s.length > 40 ? s.slice(0, 40) + "…" : s;
    }
    if (typeof val === "object" && !Array.isArray(val)) {
      return extractLabel(val as Record<string, unknown>) ?? "—";
    }
    if (Array.isArray(val) && val.length > 0) {
      const first = val[0];
      if (typeof first === "object" && first !== null) {
        return extractLabel(first as Record<string, unknown>) ?? "…";
      }
      return String(first);
    }
    return "—";
  }

  return (
    <div class="border border-base-300 rounded-lg p-4 flex flex-col gap-3">
      <Show when={!loading() && !error()}>
        <p class="text-xs text-base-content/60">
          Select fields to display on Jira issues. Preview values are sampled from your recent issues.
        </p>
      </Show>
      <Show when={loading()}>
        <div class="flex justify-center py-6">
          <LoadingSpinner size="sm" label="Loading fields..." />
        </div>
      </Show>
      <Show when={error()}>
        <p class="text-sm text-error">{error()}</p>
      </Show>
      <Show when={!loading() && !error()}>
        <input
          type="text"
          placeholder="Search fields..."
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
          class="input input-bordered input-sm w-full"
          aria-label="Search fields"
          data-picker-search
        />
        <Show when={fields().length === 0}>
          <p class="text-sm text-base-content/50 text-center py-4">
            No custom fields found on this Jira instance.
          </p>
        </Show>
        <Show when={fields().length > 0}>
          <Show when={selectedCount() >= 10}>
            <p id="field-cap-warning" class="text-xs text-warning">Maximum 10 fields selected.</p>
          </Show>
          <div role="listbox" aria-label="Custom fields" class="max-h-[400px] overflow-y-auto flex flex-col gap-1">
            <For each={filtered()}>
              {(field) => {
                const isChecked = () => selected().has(field.id);
                const isDisabled = () => !isChecked() && selectedCount() >= 10;
                return (
                  <div class={`flex items-center gap-2 px-2 py-1 rounded hover:bg-base-200 ${isDisabled() ? "opacity-40" : ""}`}>
                    <label class="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                      <input
                        type="checkbox"
                        class="checkbox checkbox-sm"
                        checked={isChecked()}
                        disabled={isDisabled()}
                        aria-describedby={isDisabled() ? "field-cap-warning" : undefined}
                        onChange={() => toggleField(field)}
                      />
                      <span class="flex-1 text-sm truncate">{field.name}</span>
                    </label>
                    <Show when={isChecked()}>
                      <div class="flex shrink-0">
                        <button type="button" class="btn btn-ghost btn-xs px-0.5" aria-label={`Move ${field.name} up`} onClick={() => moveField(field.id, "up")}>
                          <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" /></svg>
                        </button>
                        <button type="button" class="btn btn-ghost btn-xs px-0.5" aria-label={`Move ${field.name} down`} onClick={() => moveField(field.id, "down")}>
                          <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
                        </button>
                      </div>
                    </Show>
                    <span class="text-xs text-base-content/50 shrink-0 max-w-48 truncate text-right" title={previewText(field.id)}>{previewText(field.id)}</span>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </Show>
      <div class="flex gap-2 justify-end">
        <button type="button" class="btn btn-ghost btn-sm" onClick={props.onCancel}>Cancel</button>
        <button type="button" class="btn btn-primary btn-sm" onClick={handleSave}>Save</button>
      </div>
    </div>
  );
}

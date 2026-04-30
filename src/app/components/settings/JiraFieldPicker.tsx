import { createSignal, createMemo, For, Show, onMount } from "solid-js";
import type { IJiraClient } from "../../services/jira-client";
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
      const custom = allFields.filter((f) => f.custom);
      setFields(custom);

      // Best-effort sample value fetch
      const customIds = custom.map((f) => f.id).slice(0, 50);
      if (customIds.length > 0) {
        try {
          const result = await props.client.searchJql(
            "assignee = currentUser() AND statusCategory != Done",
            { maxResults: 1, fields: customIds }
          );
          if (result.issues.length === 0) {
            const fallback = await props.client.searchJql(
              "creator = currentUser() OR watcher = currentUser() AND statusCategory != Done",
              { maxResults: 1, fields: customIds }
            );
            if (fallback.issues.length > 0) {
              setSampleValues(fallback.issues[0].fields as Record<string, unknown>);
            }
          } else {
            setSampleValues(result.issues[0].fields as Record<string, unknown>);
          }
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
    return fields().filter((f) => !q || f.name.toLowerCase().includes(q));
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

  function handleSave() {
    props.onSave([...selected().values()]);
  }

  function previewText(fieldId: string): string {
    const val = sampleValues()[fieldId];
    if (val === null || val === undefined) return "—";
    if (typeof val === "string" || typeof val === "number") {
      const s = String(val);
      return s.length > 40 ? s.slice(0, 40) + "…" : s;
    }
    if (typeof val === "object" && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>;
      if (typeof obj["displayName"] === "string") return obj["displayName"];
      if (typeof obj["value"] === "string") return obj["value"];
    }
    if (Array.isArray(val) && val.length > 0) {
      const first = val[0];
      if (typeof first === "object" && first !== null) {
        const o = first as Record<string, unknown>;
        return typeof o["displayName"] === "string" ? o["displayName"] : typeof o["value"] === "string" ? o["value"] : "…";
      }
      return String(first);
    }
    return "—";
  }

  return (
    <div class="border border-base-300 rounded-lg p-4 flex flex-col gap-3">
      <p class="text-xs text-base-content/60">
        Fields shown are instance-wide. Some may not have values on all issues.
        {fields().length > 50 && " Preview values shown for first 50 fields."}
      </p>
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
        />
        <Show when={fields().length === 0}>
          <p class="text-sm text-base-content/50 text-center py-4">
            No custom fields found on this Jira instance.
          </p>
        </Show>
        <Show when={fields().length > 0}>
          <Show when={selectedCount() >= 10}>
            <p class="text-xs text-warning">Maximum 10 fields selected.</p>
          </Show>
          <div class="max-h-[400px] overflow-y-auto flex flex-col gap-1">
            <For each={filtered()}>
              {(field) => {
                const isChecked = () => selected().has(field.id);
                const isDisabled = () => !isChecked() && selectedCount() >= 10;
                return (
                  <label class={`flex items-center gap-2 px-2 py-1 rounded hover:bg-base-200 cursor-pointer ${isDisabled() ? "opacity-40 cursor-not-allowed" : ""}`}>
                    <input
                      type="checkbox"
                      class="checkbox checkbox-sm"
                      checked={isChecked()}
                      disabled={isDisabled()}
                      onChange={() => toggleField(field)}
                    />
                    <span class="flex-1 text-sm truncate">{field.name}</span>
                    <span class="badge badge-sm badge-ghost shrink-0">{field.schema?.type ?? "unknown"}</span>
                    <span class="text-xs text-base-content/50 shrink-0 w-24 truncate text-right">{previewText(field.id)}</span>
                  </label>
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

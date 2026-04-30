import { createSignal, createMemo, For, Show, onMount } from "solid-js";
import type { IJiraClient } from "../../services/jira-client";
import type { JiraFieldMeta } from "../../../shared/jira-types";
import type { JiraCustomField } from "../../../shared/schemas";
import LoadingSpinner from "../shared/LoadingSpinner";

interface JiraScopePickerProps {
  client: IJiraClient;
  selectedScopes: JiraCustomField[];
  onSave: (scopes: JiraCustomField[]) => void;
  onCancel: () => void;
}

function isUserTypeField(field: JiraFieldMeta): boolean {
  if (!field.custom) return false;
  const SYSTEM_USER_FIELDS = new Set(["assignee", "reporter", "creator"]);
  if (SYSTEM_USER_FIELDS.has(field.id)) return false;
  if (field.schema?.type === "user") return true;
  if (field.schema?.type === "array" && field.schema?.items === "user") return true;
  return false;
}

export default function JiraScopePicker(props: JiraScopePickerProps) {
  const [fields, setFields] = createSignal<JiraFieldMeta[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [search, setSearch] = createSignal("");
  const [selected, setSelected] = createSignal<Map<string, JiraCustomField>>(
    new Map(props.selectedScopes.map((s) => [s.id, s]))
  );

  onMount(async () => {
    try {
      const allFields = await props.client.getFields();
      setFields(allFields.filter(isUserTypeField));
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

  function typeLabel(field: JiraFieldMeta): string {
    return field.schema?.type === "array" ? "multi-user" : "user";
  }

  function toggleScope(field: JiraFieldMeta) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(field.id)) {
        next.delete(field.id);
      } else {
        next.set(field.id, { id: field.id, name: field.name });
      }
      return next;
    });
  }

  function handleSave() {
    props.onSave([...selected().values()]);
  }

  return (
    <div class="border border-base-300 rounded-lg p-4 flex flex-col gap-3">
      <p class="text-xs text-base-content/60">
        Select user fields to add as scope options. Each adds a{" "}
        <code class="font-mono text-xs">&lt;field&gt; in (currentUser())</code> filter to the scope dropdown.
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
          aria-label="Search scope fields"
        />
        <Show when={fields().length === 0}>
          <p class="text-sm text-base-content/50 text-center py-4">
            No user-type custom fields found on this Jira instance.
          </p>
        </Show>
        <Show when={fields().length > 0}>
          <div class="max-h-[300px] overflow-y-auto flex flex-col gap-1">
            <For each={filtered()}>
              {(field) => {
                const isChecked = () => selected().has(field.id);
                return (
                  <label class="flex items-center gap-2 px-2 py-1 rounded hover:bg-base-200 cursor-pointer">
                    <input
                      type="checkbox"
                      class="checkbox checkbox-sm"
                      checked={isChecked()}
                      onChange={() => toggleScope(field)}
                    />
                    <span class="flex-1 text-sm truncate">{field.name}</span>
                    <span class="badge badge-sm badge-ghost shrink-0">{typeLabel(field)}</span>
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

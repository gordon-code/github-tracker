import { createSignal, For, Show } from "solid-js";
import type { IgnoredItem } from "../../stores/view";

interface IgnoreBadgeProps {
  items: IgnoredItem[];
  onUnignore: (id: string) => void;
}

function typeIcon(type: IgnoredItem["type"]): string {
  switch (type) {
    case "issue":
      return "○";
    case "pullRequest":
      return "⌥";
    case "workflowRun":
      return "▶";
  }
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export default function IgnoreBadge(props: IgnoreBadgeProps) {
  const [open, setOpen] = createSignal(false);

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      setOpen(false);
    }
  }

  function handleUnignoreAll() {
    for (const item of props.items) {
      props.onUnignore(item.id);
    }
    setOpen(false);
  }

  return (
    <Show when={props.items.length > 0}>
      <div class="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          class="badge badge-neutral badge-sm cursor-pointer"
          aria-haspopup="true"
          aria-expanded={open()}
        >
          {props.items.length} ignored
        </button>

        <Show when={open()}>
          {/* Backdrop */}
          <div
            class="fixed inset-0 z-10"
            onClick={handleBackdropClick}
            aria-hidden="true"
          />

          {/* Popover */}
          <div
            class="absolute right-0 top-full mt-1 z-20 w-80 bg-base-100 border border-base-300 rounded-lg shadow-lg"
            role="dialog"
            aria-label="Ignored items"
          >
            <div class="px-3 py-2 border-b border-base-300 text-xs font-semibold text-base-content/60 uppercase tracking-wide">
              Ignored
            </div>

            <ul class="max-h-64 overflow-y-auto divide-y divide-base-300">
              <For each={props.items}>
                {(item) => (
                  <li class="flex items-start gap-2 px-3 py-2">
                    <span
                      class="mt-0.5 shrink-0 text-base-content/40 font-mono text-xs"
                      aria-label={item.type}
                    >
                      {typeIcon(item.type)}
                    </span>
                    <div class="flex-1 min-w-0">
                      <p class="text-xs text-base-content/60 truncate">
                        {item.repo}
                      </p>
                      <p class="text-sm text-base-content truncate" title={item.title}>
                        {item.title}
                      </p>
                      <p class="text-xs text-base-content/40">
                        Ignored {formatDate(item.ignoredAt)}
                      </p>
                    </div>
                    <button
                      onClick={() => props.onUnignore(item.id)}
                      class="shrink-0 text-xs text-primary hover:underline focus:outline-none focus:underline"
                    >
                      Unignore
                    </button>
                  </li>
                )}
              </For>
            </ul>

            <div class="px-3 py-2 border-t border-base-300 flex justify-end">
              <button
                onClick={handleUnignoreAll}
                class="text-xs text-error hover:underline focus:outline-none focus:underline"
              >
                Unignore All
              </button>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  );
}

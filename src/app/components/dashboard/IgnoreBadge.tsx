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
          class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium
            bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300
            hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors
            focus:outline-none focus:ring-2 focus:ring-blue-500"
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
            class="absolute right-0 top-full mt-1 z-20 w-80 rounded-lg border border-gray-200 dark:border-gray-700
              bg-white dark:bg-gray-900 shadow-lg"
            role="dialog"
            aria-label="Ignored items"
          >
            <div class="px-3 py-2 border-b border-gray-100 dark:border-gray-800 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              Ignored
            </div>

            <ul class="max-h-64 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-800">
              <For each={props.items}>
                {(item) => (
                  <li class="flex items-start gap-2 px-3 py-2">
                    <span
                      class="mt-0.5 shrink-0 text-gray-400 dark:text-gray-500 font-mono text-xs"
                      aria-label={item.type}
                    >
                      {typeIcon(item.type)}
                    </span>
                    <div class="flex-1 min-w-0">
                      <p class="text-xs text-gray-500 dark:text-gray-400 truncate">
                        {item.repo}
                      </p>
                      <p class="text-sm text-gray-800 dark:text-gray-200 truncate" title={item.title}>
                        {item.title}
                      </p>
                      <p class="text-xs text-gray-400 dark:text-gray-500">
                        Ignored {formatDate(item.ignoredAt)}
                      </p>
                    </div>
                    <button
                      onClick={() => props.onUnignore(item.id)}
                      class="shrink-0 text-xs text-blue-600 dark:text-blue-400 hover:underline focus:outline-none focus:underline"
                    >
                      Unignore
                    </button>
                  </li>
                )}
              </For>
            </ul>

            <div class="px-3 py-2 border-t border-gray-100 dark:border-gray-800 flex justify-end">
              <button
                onClick={handleUnignoreAll}
                class="text-xs text-red-600 dark:text-red-400 hover:underline focus:outline-none focus:underline"
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

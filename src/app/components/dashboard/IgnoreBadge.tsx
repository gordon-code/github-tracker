import { createSignal, For, Show } from "solid-js";
import type { IgnoredItem } from "../../stores/view";
import { Tooltip } from "../shared/Tooltip";

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
        <Tooltip content={`${props.items.length} ignored item${props.items.length === 1 ? "" : "s"}`}>
          <button
            onClick={() => setOpen((v) => !v)}
            class="btn btn-ghost btn-sm relative"
            aria-haspopup="true"
            aria-expanded={open()}
            aria-label={`${props.items.length} ignored items`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fill-rule="evenodd" d="M3.707 2.293a1 1 0 00-1.414 1.414l14 14a1 1 0 001.414-1.414l-1.473-1.473A10.014 10.014 0 0019.542 10C18.268 5.943 14.478 3 10 3a9.958 9.958 0 00-4.512 1.074l-1.78-1.781zm4.261 4.26l1.514 1.515a2.003 2.003 0 012.45 2.45l1.514 1.514a4 4 0 00-5.478-5.478z" clip-rule="evenodd" />
              <path d="M12.454 16.697L9.75 13.992a4 4 0 01-3.742-3.741L2.335 6.578A9.98 9.98 0 00.458 10c1.274 4.057 5.065 7 9.542 7 .847 0 1.669-.105 2.454-.303z" />
            </svg>
            <span class="badge badge-neutral badge-xs absolute -top-1 -right-1">{props.items.length}</span>
          </button>
        </Tooltip>

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
                      <Tooltip content={item.title} class="min-w-0 w-full">
                        <p class="text-sm text-base-content truncate">
                          {item.title}
                        </p>
                      </Tooltip>
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

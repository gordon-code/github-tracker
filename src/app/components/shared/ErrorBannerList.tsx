import { For, Show } from "solid-js";

export interface ErrorBannerItem {
  source: string;
  message: string;
  retryable?: boolean;
}

export default function ErrorBannerList(props: {
  errors?: ErrorBannerItem[];
  onDismiss?: (index: number) => void;
}) {
  return (
    <Show when={props.errors && props.errors.length > 0}>
      <div class="px-4 pt-3 space-y-1">
        <For each={props.errors}>
          {(err, index) => (
            <div
              role="alert"
              class="flex items-center gap-2 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-sm text-red-700 dark:text-red-300"
            >
              <svg
                class="h-4 w-4 shrink-0"
                fill="currentColor"
                viewBox="0 0 20 20"
                aria-hidden="true"
              >
                <path
                  fill-rule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                  clip-rule="evenodd"
                />
              </svg>
              <span class="flex-1">
                <strong>{err.source}:</strong> {err.message}
                {err.retryable && " (will retry)"}
              </span>
              <Show when={props.onDismiss}>
                <button
                  onClick={() => props.onDismiss!(index())}
                  class="shrink-0 text-red-400 hover:text-red-600 dark:hover:text-red-200"
                  aria-label="Dismiss error"
                >
                  <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                    <path
                      fill-rule="evenodd"
                      d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                      clip-rule="evenodd"
                    />
                  </svg>
                </button>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import {
  getNotifications,
  markAllAsRead,
  clearNotifications,
  dismissError,
  mutedSources,
} from "../../lib/errors";
import { relativeTime } from "../../lib/format";
import { severityConfig } from "./ToastContainer";

interface NotificationDrawerProps {
  open: boolean;
  onClose: () => void;
}

export default function NotificationDrawer(props: NotificationDrawerProps) {
  const [visible, setVisible] = createSignal(false);
  const [closing, setClosing] = createSignal(false);
  let closeTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let closeButtonRef: HTMLButtonElement | undefined;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const animDelay = reducedMotion ? 0 : 300;

  createEffect(() => {
    if (props.open) {
      // Clear any pending close timeout on re-open
      if (closeTimeoutHandle !== undefined) {
        clearTimeout(closeTimeoutHandle);
        closeTimeoutHandle = undefined;
      }
      setClosing(false);
      setVisible(true);
      queueMicrotask(() => closeButtonRef?.focus());
    } else {
      if (visible()) {
        setClosing(true);
        closeTimeoutHandle = setTimeout(() => {
          setVisible(false);
          closeTimeoutHandle = undefined;
        }, animDelay);
      }
    }
  });

  onCleanup(() => {
    if (closeTimeoutHandle !== undefined) clearTimeout(closeTimeoutHandle);
  });

  // Escape key handler
  createEffect(() => {
    if (!visible()) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", handler);
    onCleanup(() => document.removeEventListener("keydown", handler));
  });

  function handleDismissAll() {
    const current = getNotifications();
    for (const n of current) mutedSources.add(n.source);
    clearNotifications();
  }

  return (
    <Show when={visible()}>
      <>
        {/* Overlay */}
        <div
          class="fixed inset-0 z-[70] bg-black/40"
          classList={{
            "animate-overlay-in": !closing(),
            "animate-overlay-out": closing(),
          }}
          onClick={props.onClose}
          aria-hidden="true"
        />
        {/* Drawer panel */}
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Notifications"
          class="fixed top-0 right-0 h-full w-80 sm:w-96 bg-white dark:bg-gray-800 shadow-xl z-[71] flex flex-col"
          classList={{
            "animate-drawer-in": !closing(),
            "animate-drawer-out": closing(),
          }}
        >
          {/* Header */}
          <div class="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
            <h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100 flex-1">
              Notifications
            </h2>
            <button
              onClick={markAllAsRead}
              class="text-sm text-blue-500 hover:text-blue-700 dark:hover:text-blue-300"
            >
              Mark all as read
            </button>
            <button
              onClick={handleDismissAll}
              class="text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            >
              Dismiss all
            </button>
            <button
              ref={closeButtonRef}
              onClick={props.onClose}
              aria-label="Close notifications"
              class="ml-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            >
              <svg class="h-5 w-5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path
                  fill-rule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  clip-rule="evenodd"
                />
              </svg>
            </button>
          </div>

          {/* Notification list */}
          <div class="flex-1 overflow-y-auto">
            <Show
              when={getNotifications().length > 0}
              fallback={
                <div class="flex items-center justify-center h-full text-gray-500 dark:text-gray-400 text-sm">
                  No notifications
                </div>
              }
            >
              <ul>
                <For each={getNotifications().slice().reverse()}>
                  {(notif) => {
                    const cfg = severityConfig(notif.severity);
                    return (
                      <li
                        class={`flex items-start gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-700 border-l-4 ${cfg.borderClass} ${!notif.read ? "bg-blue-50/50 dark:bg-blue-900/10" : ""}`}
                      >
                        <svg
                          class={`h-5 w-5 shrink-0 mt-0.5 ${cfg.iconClass}`}
                          viewBox="0 0 20 20"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <path fill-rule="evenodd" d={cfg.path} clip-rule="evenodd" />
                          {cfg.secondaryPath && (
                            <path
                              fill-rule="evenodd"
                              d={cfg.secondaryPath}
                              clip-rule="evenodd"
                            />
                          )}
                        </svg>
                        <div class="flex-1 min-w-0">
                          <p class="text-sm text-gray-800 dark:text-gray-200">
                            <strong>{notif.source}:</strong> {notif.message}
                            {notif.retryable && (
                              <span class="ml-1 text-gray-500 dark:text-gray-400 text-xs">
                                (will retry)
                              </span>
                            )}
                          </p>
                          <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                            {relativeTime(new Date(notif.timestamp).toISOString())}
                          </p>
                        </div>
                        <button
                          onClick={() => dismissError(notif.id)}
                          aria-label="Dismiss notification"
                          class="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 mt-0.5"
                        >
                          <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                            <path
                              fill-rule="evenodd"
                              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                              clip-rule="evenodd"
                            />
                          </svg>
                        </button>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </Show>
          </div>
        </div>
      </>
    </Show>
  );
}

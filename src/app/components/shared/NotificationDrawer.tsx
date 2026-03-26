import { createMemo, For, Show } from "solid-js";
import Drawer from "corvu/drawer";
import {
  getNotifications,
  markAllAsRead,
  clearNotifications,
  dismissError,
  addMutedSource,
} from "../../lib/errors";
import { relativeTime } from "../../lib/format";
import { severityConfig } from "./ToastContainer";

interface NotificationDrawerProps {
  open: boolean;
  onClose: () => void;
}

export default function NotificationDrawer(props: NotificationDrawerProps) {
  const sortedNotifications = createMemo(() => getNotifications().slice().reverse());

  function handleDismissAll() {
    const current = getNotifications();
    for (const n of current) addMutedSource(n.source);
    clearNotifications();
  }

  return (
    <Drawer open={props.open} onOpenChange={(open) => !open && props.onClose()} side="right">
      <Drawer.Portal>
        <Drawer.Overlay class="fixed inset-0 bg-black/50 z-[70]" />
        <Drawer.Content class="fixed top-0 right-0 h-full w-80 sm:w-96 bg-base-100 shadow-xl z-[71] flex flex-col">
          {/* Header */}
          <div class="flex items-center gap-2 px-4 py-3 border-b border-base-300 shrink-0">
            <Drawer.Label class="text-lg font-semibold text-base-content flex-1">
              Notifications
            </Drawer.Label>
            <button
              type="button"
              onClick={markAllAsRead}
              class="text-sm text-primary hover:text-primary/80"
            >
              Mark all as read
            </button>
            <button
              type="button"
              onClick={handleDismissAll}
              class="text-sm text-base-content/60 hover:text-base-content"
            >
              Dismiss all
            </button>
            <Drawer.Close
              class="btn btn-ghost btn-sm btn-circle ml-1"
              aria-label="Close notifications"
            >
              <svg class="h-5 w-5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path
                  fill-rule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  clip-rule="evenodd"
                />
              </svg>
            </Drawer.Close>
          </div>

          {/* Notification list */}
          <div class="flex-1 overflow-y-auto">
            <Show
              when={sortedNotifications().length > 0}
              fallback={
                <div class="flex items-center justify-center h-full text-base-content/50 text-sm">
                  No notifications
                </div>
              }
            >
              <ul>
                <For each={sortedNotifications()}>
                  {(notif) => {
                    const cfg = severityConfig(notif.severity);
                    return (
                      <li
                        class={`flex items-start gap-3 px-4 py-3 border-b border-base-300 border-l-4 ${cfg.borderClass} ${!notif.read ? "bg-info/10" : ""}`}
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
                          <p class="text-sm text-base-content">
                            <strong>{notif.source}:</strong> {notif.message}
                            {notif.retryable && (
                              <span class="ml-1 text-base-content/50 text-xs">
                                (will retry)
                              </span>
                            )}
                          </p>
                          <p class="text-xs text-base-content/50 mt-0.5">
                            {relativeTime(new Date(notif.timestamp).toISOString())}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => dismissError(notif.id)}
                          aria-label="Dismiss notification"
                          class="shrink-0 text-base-content/40 hover:text-base-content mt-0.5"
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
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer>
  );
}

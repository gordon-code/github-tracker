import { createEffect, createSignal, For, onCleanup } from "solid-js";
import {
  getNotifications,
  mutedSources,
  type AppNotification,
  type NotificationSeverity,
} from "../../lib/errors";

// Severity configuration — shared with NotificationDrawer (imported there after C4)
export interface SeverityConfig {
  path: string;
  secondaryPath?: string;
  iconClass: string;
  borderClass: string;
  bgClass: string;
  textClass: string;
  borderColorClass: string;
}

export function severityConfig(severity: NotificationSeverity): SeverityConfig {
  switch (severity) {
    case "error":
      return {
        path: "M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z",
        iconClass: "text-red-500 dark:text-red-400",
        borderClass: "border-l-red-400",
        bgClass: "bg-red-50 dark:bg-red-900/30",
        textClass: "text-red-800 dark:text-red-200",
        borderColorClass: "border-red-200 dark:border-red-800",
      };
    case "warning":
      return {
        path: "M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495z",
        secondaryPath:
          "M10 12a.75.75 0 01-.75-.75v-3.5a.75.75 0 011.5 0v3.5A.75.75 0 0110 12zm0 3a1 1 0 100-2 1 1 0 000 2z",
        iconClass: "text-yellow-500 dark:text-yellow-400",
        borderClass: "border-l-yellow-400",
        bgClass: "bg-yellow-50 dark:bg-yellow-900/30",
        textClass: "text-yellow-800 dark:text-yellow-200",
        borderColorClass: "border-yellow-200 dark:border-yellow-800",
      };
    case "info":
      return {
        path: "M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z",
        iconClass: "text-blue-500 dark:text-blue-400",
        borderClass: "border-l-blue-400",
        bgClass: "bg-blue-50 dark:bg-blue-900/30",
        textClass: "text-blue-800 dark:text-blue-200",
        borderColorClass: "border-blue-200 dark:border-blue-800",
      };
  }
}

interface ToastItem {
  notification: AppNotification;
  dismissing: boolean;
}

export default function ToastContainer() {
  // seenTimestamps: notification ID → last-seen timestamp (detect new/updated)
  const seenTimestamps = new Map<string, number>();
  // lastToastedAt: source → timestamp of last toast shown (cooldown tracking)
  const lastToastedAt = new Map<string, number>();
  // visibleToasts: IDs of toasts currently on screen
  const [visibleToasts, setVisibleToasts] = createSignal<Map<string, ToastItem>>(new Map());
  // pending timeout handles: notification ID → timeout handle
  const timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  // dismissing animation timeouts
  const dismissingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  const COOLDOWN_MS = 60_000;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const animDelay = reducedMotion ? 0 : 300;

  function removeToast(id: string) {
    setVisibleToasts((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

  function startDismissAnimation(id: string) {
    // Guard: if already dismissing, don't create a duplicate timeout
    const existing = dismissingTimeouts.get(id);
    if (existing !== undefined) return;

    // Switch to dismiss animation
    setVisibleToasts((prev) => {
      const next = new Map(prev);
      const item = next.get(id);
      if (item) next.set(id, { ...item, dismissing: true });
      return next;
    });
    // Remove after animation
    const t = setTimeout(() => {
      dismissingTimeouts.delete(id);
      removeToast(id);
    }, animDelay);
    dismissingTimeouts.set(id, t);
  }

  function dismissToast(id: string) {
    // Clear auto-dismiss timeout
    const autoTimeout = timeouts.get(id);
    if (autoTimeout !== undefined) {
      clearTimeout(autoTimeout);
      timeouts.delete(id);
    }
    startDismissAnimation(id);
  }

  function scheduleAutoDismiss(notification: AppNotification) {
    const delay = notification.severity === "error" ? 10_000 : 5_000;
    const t = setTimeout(() => {
      timeouts.delete(notification.id);
      startDismissAnimation(notification.id);
    }, delay);
    timeouts.set(notification.id, t);
  }

  createEffect(() => {
    const notifs = getNotifications();
    for (const notif of notifs) {
      const lastSeen = seenTimestamps.get(notif.id);
      const isNew = lastSeen === undefined;
      const isUpdated = lastSeen !== undefined && notif.timestamp > lastSeen;

      if (!isNew && !isUpdated) continue;

      // Always update seenTimestamps
      seenTimestamps.set(notif.id, notif.timestamp);

      // Check suppression conditions
      const lastToasted = lastToastedAt.get(notif.source);
      const inCooldown = lastToasted !== undefined && Date.now() - lastToasted < COOLDOWN_MS;
      const muted = mutedSources.has(notif.source);

      if (inCooldown || muted) continue;

      // Show toast
      lastToastedAt.set(notif.source, Date.now());
      setVisibleToasts((prev) => {
        const next = new Map(prev);
        next.set(notif.id, { notification: notif, dismissing: false });
        return next;
      });
      scheduleAutoDismiss(notif);
    }

    // Prune stale entries from tracking Maps (IDs/sources no longer in store)
    const currentIds = new Set(notifs.map(n => n.id));
    for (const id of seenTimestamps.keys()) {
      if (!currentIds.has(id)) seenTimestamps.delete(id);
    }
    const currentSources = new Set(notifs.map(n => n.source));
    for (const source of lastToastedAt.keys()) {
      if (!currentSources.has(source)) lastToastedAt.delete(source);
    }
    // Remove visible toasts whose notifications were dismissed from the store
    for (const id of visibleToasts().keys()) {
      if (!currentIds.has(id)) {
        const t = timeouts.get(id);
        if (t !== undefined) { clearTimeout(t); timeouts.delete(id); }
        const dt = dismissingTimeouts.get(id);
        if (dt !== undefined) { clearTimeout(dt); dismissingTimeouts.delete(id); }
        removeToast(id);
      }
    }
  });

  onCleanup(() => {
    for (const t of timeouts.values()) clearTimeout(t);
    for (const t of dismissingTimeouts.values()) clearTimeout(t);
  });

  return (
    <div class="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-[calc(100vw-2rem)] max-w-96" aria-live="assertive" aria-atomic="false">
      <For each={[...visibleToasts().values()]}>
        {(item) => {
          const cfg = severityConfig(item.notification.severity);
          return (
            <div
              role="alert"
              class={`flex items-start gap-3 rounded-lg border p-3 shadow-lg ${cfg.bgClass} ${cfg.textClass} ${cfg.borderColorClass} ${item.dismissing ? "animate-toast-out" : "animate-toast-in"}`}
            >
              <svg
                class={`h-5 w-5 shrink-0 ${cfg.iconClass}`}
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden="true"
              >
                <path fill-rule="evenodd" d={cfg.path} clip-rule="evenodd" />
                {cfg.secondaryPath && (
                  <path fill-rule="evenodd" d={cfg.secondaryPath} clip-rule="evenodd" />
                )}
              </svg>
              <span class="flex-1 text-sm">
                <strong>{item.notification.source}:</strong> {item.notification.message}
                {item.notification.retryable && (
                  <span class="ml-1 opacity-75">(will retry)</span>
                )}
              </span>
              <button
                onClick={() => dismissToast(item.notification.id)}
                class="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
                aria-label="Dismiss notification"
              >
                <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                  <path
                    fill-rule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                    clip-rule="evenodd"
                  />
                </svg>
              </button>
            </div>
          );
        }}
      </For>
    </div>
  );
}

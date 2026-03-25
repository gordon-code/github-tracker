import { createSignal } from "solid-js";

export type NotificationSeverity = "error" | "warning" | "info";

export interface AppNotification {
  id: string;
  source: string;
  message: string;
  timestamp: number;
  retryable: boolean;
  severity: NotificationSeverity;
  read: boolean;
}

// Backward-compat alias
export type AppError = AppNotification;

const MAX_NOTIFICATIONS = 50;

const [notifications, setNotifications] = createSignal<AppNotification[]>([]);

let notificationCounter = 0;

// Cycle tracking for poll reconciliation
let _cycleTracking: Set<string> | null = null;

export function startCycleTracking(): void {
  _cycleTracking = new Set();
}

export function endCycleTracking(): Set<string> {
  const result = _cycleTracking ?? new Set();
  _cycleTracking = null;
  return result;
}

export function pushNotification(
  source: string,
  message: string,
  severity: NotificationSeverity,
  retryable = false
): void {
  // Record source in cycle tracking even for no-ops
  if (_cycleTracking) _cycleTracking.add(source);

  setNotifications((prev) => {
    const existing = prev.find((n) => n.source === source);
    if (existing) {
      if (existing.message === message) {
        // Same source + same message: no-op — prevents toast spam
        return prev;
      }
      // Same source + different message: update, reset read, update timestamp
      return prev
        .map((n) =>
          n.source === source
            ? { ...n, message, severity, retryable, read: false, timestamp: Date.now() }
            : n
        )
        .slice(-MAX_NOTIFICATIONS);
    }
    const id = `notif-${++notificationCounter}-${Date.now()}`;
    return [...prev, { id, source, message, timestamp: Date.now(), retryable, severity, read: false }].slice(
      -MAX_NOTIFICATIONS
    );
  });
}

export function pushError(source: string, message: string, retryable = false): void {
  pushNotification(source, message, "error", retryable);
}

export function dismissError(id: string): void {
  setNotifications((prev) => prev.filter((n) => n.id !== id));
}

export function dismissNotificationBySource(source: string): void {
  setNotifications((prev) => prev.filter((n) => n.source !== source));
}

export function markAllAsRead(): void {
  setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
}

export function getUnreadCount(): number {
  return notifications().filter((n) => !n.read).length;
}

export function getNotifications(): AppNotification[] {
  return notifications();
}

// Backward-compat alias
export function getErrors(): AppNotification[] {
  return notifications();
}

// Muted sources — suppress toasts for these sources after "Dismiss all"
// Session-only, reset on page reload and on logout (via resetNotificationState)
export const mutedSources = new Set<string>();

export function clearNotifications(): void {
  setNotifications([]);
}

export function resetNotificationState(): void {
  setNotifications([]);
  mutedSources.clear();
}

// Backward-compat alias
export function clearErrors(): void {
  clearNotifications();
}

import { createSignal } from "solid-js";

export type NotificationSeverity = "error" | "warning" | "info";

export interface NotificationAction {
  label: string;
  href: string;
}

export interface AppNotification {
  id: string;
  source: string;
  message: string;
  timestamp: number;
  retryable: boolean;
  severity: NotificationSeverity;
  read: boolean;
  action?: NotificationAction;
  silentToast?: boolean;
}

export interface PushNotificationOptions {
  silentToast?: boolean;
}

export function isSafeInternalHref(href: string): boolean {
  return /^\/(?!\/|\\)/.test(href);
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
  retryable = false,
  action?: NotificationAction,
  options?: PushNotificationOptions
): void {
  // Record source in cycle tracking even for no-ops
  if (_cycleTracking) _cycleTracking.add(source);

  const safeAction = action && isSafeInternalHref(action.href) ? action : undefined;
  const silentToast = options?.silentToast;

  setNotifications((prev) => {
    const existing = prev.find((n) => n.source === source);
    if (existing) {
      if (
        existing.message === message &&
        existing.action?.href === safeAction?.href &&
        existing.action?.label === safeAction?.label
      ) {
        // Same source + same message + same action: no-op — prevents toast spam
        return prev;
      }
      // Same source + different message or action: update, reset read, update timestamp
      return prev
        .map((n) =>
          n.source === source
            ? {
                ...n,
                message,
                severity,
                retryable,
                action: safeAction,
                read: false,
                timestamp: Date.now(),
                silentToast,
              }
            : n
        )
        .slice(-MAX_NOTIFICATIONS);
    }
    const id = `notif-${++notificationCounter}-${Date.now()}`;
    return [
      ...prev,
      {
        id,
        source,
        message,
        timestamp: Date.now(),
        retryable,
        severity,
        read: false,
        ...(safeAction ? { action: safeAction } : {}),
        ...(silentToast ? { silentToast: true } : {}),
      },
    ].slice(-MAX_NOTIFICATIONS);
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
const [_mutedSources, _setMutedSources] = createSignal(new Set<string>());

export function addMutedSource(source: string): void {
  _setMutedSources((prev) => new Set([...prev, source]));
}

export function isMuted(source: string): boolean {
  return _mutedSources().has(source);
}

export function clearMutedSources(): void {
  _setMutedSources(new Set<string>());
}

export function clearNotifications(): void {
  setNotifications([]);
}

export function resetNotificationState(): void {
  setNotifications([]);
  clearMutedSources();
}

// Backward-compat alias
export function clearErrors(): void {
  clearNotifications();
}

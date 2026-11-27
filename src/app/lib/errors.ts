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
let _activeCycleToken: symbol | null = null;

export function startCycleTracking(): symbol {
  const token = Symbol("poll-cycle");
  _activeCycleToken = token;
  _cycleTracking = new Set();
  return token;
}

export function endCycleTracking(token?: symbol): Set<string> {
  if (token !== undefined && token !== _activeCycleToken) {
    return new Set();
  }
  const result = _cycleTracking ?? new Set();
  _cycleTracking = null;
  _activeCycleToken = null;
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

const _dismissListeners = new Map<string, Set<() => void>>();

export function onNotificationDismissed(source: string, cb: () => void): () => void {
  let listeners = _dismissListeners.get(source);
  if (!listeners) {
    listeners = new Set();
    _dismissListeners.set(source, listeners);
  }
  listeners.add(cb);
  return () => {
    const current = _dismissListeners.get(source);
    if (!current) return;
    current.delete(cb);
    if (current.size === 0) {
      _dismissListeners.delete(source);
    }
  };
}

function notifyDismissListeners(source: string): void {
  const listeners = _dismissListeners.get(source);
  if (!listeners || listeners.size === 0) return;
  for (const cb of Array.from(listeners)) {
    try {
      cb();
    } catch {
      // Listener errors must never break notification dismissal
    }
  }
}

export function dismissError(id: string): void {
  const removed = notifications().find((n) => n.id === id);
  setNotifications((prev) => prev.filter((n) => n.id !== id));
  if (removed) {
    notifyDismissListeners(removed.source);
  }
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
  notifyDismissListeners(source);
}

export function removeMutedSource(source: string): void {
  _setMutedSources((prev) => {
    if (!prev.has(source)) return prev;
    const next = new Set(prev);
    next.delete(source);
    return next;
  });
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
  _cycleTracking = null;
  _activeCycleToken = null;
}

// Backward-compat alias
export function clearErrors(): void {
  clearNotifications();
}

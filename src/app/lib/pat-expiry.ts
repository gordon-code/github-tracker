import { PAT_EXPIRY_DISMISSED_KEY } from "../../shared/types";
import type { Config } from "../../shared/schemas";
import {
  pushNotification,
  dismissNotificationBySource,
  onNotificationDismissed,
  removeMutedSource,
} from "./errors";

export { PAT_EXPIRY_DISMISSED_KEY };

export const PAT_EXPIRY_NOTIFICATION_SOURCE = "pat-expiry";
export const PAT_SETTINGS_ACTION = {
  label: "Update PAT in Settings",
  href: "/settings#data",
} as const;

export type PatExpiryTier = "ok" | "7d" | "3d" | "1d" | "expired";

export interface PatExpiryStatus {
  tier: PatExpiryTier;
  daysRemaining: number;
  message: string;
  severity: "info" | "warning" | "error";
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

export function daysUntilPatExpiry(dateStr: string, now = new Date()): number | null {
  const match = ISO_DATE_RE.exec(dateStr);
  if (!match) return null;

  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);

  // Use setUTCFullYear (never Date.UTC) so 2-digit years 0000-0099 are not mapped to 1900-1999.
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }

  const today = new Date(0);
  today.setUTCFullYear(now.getFullYear(), now.getMonth(), now.getDate());

  return (dt.getTime() - today.getTime()) / MS_PER_DAY;
}

export function getPatExpiryStatus(dateStr: string | null, now = new Date()): PatExpiryStatus | null {
  if (!dateStr) return null;
  const days = daysUntilPatExpiry(dateStr, now);
  if (days === null) return null;

  if (days > 7) {
    return {
      tier: "ok",
      daysRemaining: days,
      severity: "info",
      message: `Expires in ${days} days (${dateStr})`,
    };
  }
  if (days >= 4) {
    return {
      tier: "7d",
      daysRemaining: days,
      severity: "warning",
      message: `Your GitHub PAT expires on ${dateStr} (within 7 days).`,
    };
  }
  if (days >= 2) {
    return {
      tier: "3d",
      daysRemaining: days,
      severity: "warning",
      message: `Your GitHub PAT expires on ${dateStr} (within 3 days).`,
    };
  }
  if (days >= 0) {
    return {
      tier: "1d",
      daysRemaining: days,
      severity: "error",
      message:
        days === 0
          ? `Your GitHub PAT expires today (${dateStr}).`
          : `Your GitHub PAT expires tomorrow (${dateStr}).`,
    };
  }
  return {
    tier: "expired",
    daysRemaining: days,
    severity: "error",
    message: `Your GitHub PAT expired on ${dateStr}. Replace it in Settings.`,
  };
}

function readDismissedKey(): string | null {
  try {
    return localStorage.getItem(PAT_EXPIRY_DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissedKey(key: string): void {
  try {
    localStorage.setItem(PAT_EXPIRY_DISMISSED_KEY, key);
  } catch {
    // Ignore storage quota/availability errors
  }
}

function removeDismissedKey(): void {
  try {
    localStorage.removeItem(PAT_EXPIRY_DISMISSED_KEY);
  } catch {
    // Ignore storage availability errors
  }
}

function dismissKeyFor(dateStr: string, tier: PatExpiryTier): string {
  return `${dateStr}:${tier}`;
}

let _activePatExpiryKey: string | null = null;
let _unsubscribeDismiss: (() => void) | null = null;

function ensureDismissListener(): void {
  if (_unsubscribeDismiss === null) {
    const unsub = onNotificationDismissed(PAT_EXPIRY_NOTIFICATION_SOURCE, () => {
      if (_activePatExpiryKey) writeDismissedKey(_activePatExpiryKey);
    });
    _unsubscribeDismiss = typeof unsub === "function" ? unsub : () => {};
  }
}

export function clearPatExpiryDismissal(): void {
  _activePatExpiryKey = null;
  removeDismissedKey();
  removeMutedSource(PAT_EXPIRY_NOTIFICATION_SOURCE);
  dismissNotificationBySource(PAT_EXPIRY_NOTIFICATION_SOURCE);
}

export function checkPatExpiryReminder(
  authMethod: Config["authMethod"],
  patExpiresAt: string | null,
  now = new Date()
): void {
  if (authMethod !== "pat" || !patExpiresAt) {
    if (_activePatExpiryKey !== null) {
      dismissNotificationBySource(PAT_EXPIRY_NOTIFICATION_SOURCE);
    }
    _activePatExpiryKey = null;
    return;
  }

  const status = getPatExpiryStatus(patExpiresAt, now);
  if (!status || status.tier === "ok") {
    if (_activePatExpiryKey !== null) {
      dismissNotificationBySource(PAT_EXPIRY_NOTIFICATION_SOURCE);
    }
    _activePatExpiryKey = null;
    return;
  }

  ensureDismissListener();
  const key = dismissKeyFor(patExpiresAt, status.tier);

  if (readDismissedKey() === key) {
    if (_activePatExpiryKey !== null && _activePatExpiryKey !== key) {
      dismissNotificationBySource(PAT_EXPIRY_NOTIFICATION_SOURCE);
    }
    _activePatExpiryKey = key;
    return;
  }

  _activePatExpiryKey = key;
  removeMutedSource(PAT_EXPIRY_NOTIFICATION_SOURCE);
  pushNotification(
    PAT_EXPIRY_NOTIFICATION_SOURCE,
    status.message,
    status.severity,
    false,
    PAT_SETTINGS_ACTION
  );
}

export function _resetPatExpiryState(): void {
  _unsubscribeDismiss?.();
  _unsubscribeDismiss = null;
  _activePatExpiryKey = null;
}

import { PAT_EXPIRY_DISMISSED_KEY } from "../../shared/types";
import type { Config } from "../../shared/schemas";
import { onAuthCleared } from "../stores/auth";
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

// Tier lower bounds in whole days until expiry: more than 7 → ok, 4-7 → "7d",
// 2-3 → "3d", 0-1 → "1d", negative → expired.
const OK_ABOVE_DAYS = 7;
const SEVEN_DAY_TIER_MIN_DAYS = 4;
const THREE_DAY_TIER_MIN_DAYS = 2;
const ONE_DAY_TIER_MIN_DAYS = 0;

let _dismissedPatExpiryKey: string | null = null;
let _activePatExpiryKey: string | null = null;
let _unsubscribeDismiss: (() => void) | null = null;
let _authClearRegistered = false;

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

  if (days > OK_ABOVE_DAYS) {
    return {
      tier: "ok",
      daysRemaining: days,
      severity: "info",
      message: `Expires in ${days} days (${dateStr})`,
    };
  }
  if (days >= SEVEN_DAY_TIER_MIN_DAYS) {
    return {
      tier: "7d",
      daysRemaining: days,
      severity: "warning",
      message: `Your GitHub PAT expires on ${dateStr} (within 7 days).`,
    };
  }
  if (days >= THREE_DAY_TIER_MIN_DAYS) {
    return {
      tier: "3d",
      daysRemaining: days,
      severity: "warning",
      message: `Your GitHub PAT expires on ${dateStr} (within 3 days).`,
    };
  }
  if (days >= ONE_DAY_TIER_MIN_DAYS) {
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

export function formatPatExpiryBadgeLabel(status: PatExpiryStatus): string {
  if (status.tier === "expired") return `Expired (${Math.abs(status.daysRemaining)}d ago)`;
  if (status.daysRemaining === 0) return "Expires today";
  if (status.daysRemaining === 1) return "Expires tomorrow";
  return `Expires in ${status.daysRemaining}d`;
}

function readDismissedKey(): string | null {
  try {
    return localStorage.getItem(PAT_EXPIRY_DISMISSED_KEY) ?? _dismissedPatExpiryKey;
  } catch {
    return _dismissedPatExpiryKey;
  }
}

function writeDismissedKey(key: string): void {
  try {
    localStorage.setItem(PAT_EXPIRY_DISMISSED_KEY, key);
    _dismissedPatExpiryKey = null;
  } catch {
    _dismissedPatExpiryKey = key;
  }
}

function removeDismissedKey(): void {
  _dismissedPatExpiryKey = null;
  try {
    localStorage.removeItem(PAT_EXPIRY_DISMISSED_KEY);
  } catch {
    // Ignore storage availability errors
  }
}

function dismissKeyFor(dateStr: string, tier: PatExpiryTier): string {
  return `${dateStr}:${tier}`;
}

function dismissActiveNotification(): void {
  if (_activePatExpiryKey !== null) {
    dismissNotificationBySource(PAT_EXPIRY_NOTIFICATION_SOURCE);
  }
}

function ensureDismissListener(): void {
  if (_unsubscribeDismiss === null) {
    _unsubscribeDismiss = onNotificationDismissed(PAT_EXPIRY_NOTIFICATION_SOURCE, () => {
      if (_activePatExpiryKey) writeDismissedKey(_activePatExpiryKey);
    });
  }
  // onAuthCleared has no unregister, so this callback is registered once for the
  // module's lifetime (_resetPatExpiryState intentionally leaves the flag set).
  if (!_authClearRegistered) {
    _authClearRegistered = true;
    onAuthCleared(() => {
      _activePatExpiryKey = null;
      _dismissedPatExpiryKey = null;
    });
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
    dismissActiveNotification();
    _activePatExpiryKey = null;
    _dismissedPatExpiryKey = null;
    return;
  }

  const status = getPatExpiryStatus(patExpiresAt, now);
  if (!status || status.tier === "ok") {
    dismissActiveNotification();
    _activePatExpiryKey = null;
    return;
  }

  ensureDismissListener();
  const key = dismissKeyFor(patExpiresAt, status.tier);

  if (readDismissedKey() === key) {
    if (_activePatExpiryKey !== key) dismissActiveNotification();
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
  _dismissedPatExpiryKey = null;
}

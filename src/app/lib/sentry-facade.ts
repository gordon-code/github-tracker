import { scrubUrl } from "./sentry";
import type { initSdk } from "./sentry-init";

export interface CaptureHint {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  mechanism?: { handled: boolean; type: string };
}

interface QueuedCapture {
  error: Error;
  hint?: CaptureHint;
}

const MAX_QUEUE_SIZE = 20;

type SentrySdk = ReturnType<typeof initSdk>;

const queue: QueuedCapture[] = [];
let sdk: SentrySdk | null = null;
let loadStarted = false;
let loadErrorWarned = false;
let resetGeneration = 0;

let onWindowError: ((event: ErrorEvent) => void) | null = null;
let onUnhandledRejection: ((event: PromiseRejectionEvent) => void) | null = null;
let scheduledIdleId: number | null = null;
let scheduledTimeoutId: ReturnType<typeof setTimeout> | null = null;

function isSentryEnabled(): boolean {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  return !import.meta.env.DEV && Boolean(dsn);
}

function scrubErrorForQueue(err: unknown): Error {
  if (err instanceof Error) {
    const copy = new Error(scrubUrl(err.message));
    copy.name = err.name;
    if (typeof err.stack === "string") {
      copy.stack = scrubUrl(err.stack);
    }
    return copy;
  }
  return new Error(scrubUrl(String(err)));
}

function removeEarlyListeners(): void {
  if (typeof window === "undefined") return;
  if (onWindowError) {
    window.removeEventListener("error", onWindowError);
    onWindowError = null;
  }
  if (onUnhandledRejection) {
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
    onUnhandledRejection = null;
  }
}

export function installEarlyErrorCapture(): void {
  if (!isSentryEnabled() || sdk !== null || onWindowError !== null) return;
  if (typeof window === "undefined") return;

  onWindowError = (event: ErrorEvent) => {
    captureException(event.error ?? event.message);
  };
  onUnhandledRejection = (event: PromiseRejectionEvent) => {
    captureException(event.reason);
  };

  window.addEventListener("error", onWindowError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
}

export function startSentryLoad(): void {
  if (!isSentryEnabled() || loadStarted) return;
  loadStarted = true;
  const myGeneration = resetGeneration;

  const load = () => {
    scheduledIdleId = null;
    scheduledTimeoutId = null;
    if (myGeneration !== resetGeneration) return;

    void (async () => {
      try {
        const mod = await import("./sentry-init");
        if (myGeneration !== resetGeneration) return;
        const initializedSdk = mod.initSdk();
        removeEarlyListeners();
        sdk = initializedSdk;
        const pending = queue.splice(0);
        for (const item of pending) {
          initializedSdk.captureException(
            item.error,
            item.hint as Parameters<SentrySdk["captureException"]>[1],
          );
        }
      } catch (err: unknown) {
        if (myGeneration !== resetGeneration) return;
        removeEarlyListeners();
        if (!loadErrorWarned) {
          loadErrorWarned = true;
          console.warn("[app] Failed to load Sentry SDK:", err);
        }
      }
    })();
  };

  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    scheduledIdleId = window.requestIdleCallback(load);
  } else {
    scheduledTimeoutId = setTimeout(load, 2000);
  }
}

export function captureException(err: unknown, hint?: CaptureHint): void {
  if (!isSentryEnabled()) return;

  if (sdk !== null) {
    sdk.captureException(
      err,
      hint as Parameters<SentrySdk["captureException"]>[1],
    );
    return;
  }

  const scrubbedError = scrubErrorForQueue(err);
  if (queue.length >= MAX_QUEUE_SIZE) {
    queue.shift();
  }
  queue.push({ error: scrubbedError, hint });
}

export function reportBoundaryError(err: unknown): void {
  captureException(err, {
    mechanism: { handled: true, type: "auto.function.solid.error_boundary" },
  });
}

export function _resetSentryFacadeForTests(): void {
  resetGeneration++;
  removeEarlyListeners();
  if (
    scheduledIdleId !== null &&
    typeof window !== "undefined" &&
    typeof window.cancelIdleCallback === "function"
  ) {
    window.cancelIdleCallback(scheduledIdleId);
  }
  if (scheduledTimeoutId !== null) {
    clearTimeout(scheduledTimeoutId);
  }
  scheduledIdleId = null;
  scheduledTimeoutId = null;
  sdk = null;
  loadStarted = false;
  loadErrorWarned = false;
  queue.length = 0;
}

export function _getSentryQueueForTests(): readonly QueuedCapture[] {
  return queue;
}

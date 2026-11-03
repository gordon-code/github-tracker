import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { beforeSendHandler } from "../../src/app/lib/sentry";
import {
  installEarlyErrorCapture,
  startSentryLoad,
  captureException,
  reportBoundaryError,
  _resetSentryFacadeForTests,
  _getSentryQueueForTests,
} from "../../src/app/lib/sentry-facade";

const mockSentryInit = vi.fn();
const mockSentryCaptureException = vi.fn();

vi.mock("@sentry/solid", () => ({
  init: (...args: unknown[]) => mockSentryInit(...args),
  captureException: (...args: unknown[]) => mockSentryCaptureException(...args),
}));

let shouldFailSentryInitImport = false;
vi.mock("../../src/app/lib/sentry-init", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/lib/sentry-init")>();
  return {
    ...actual,
    initSdk: vi.fn(() => {
      if (shouldFailSentryInitImport) {
        throw new Error("ChunkLoadError: Loading chunk sentry-init failed");
      }
      return actual.initSdk();
    }),
  };
});

describe("sentry-facade", () => {
  beforeEach(() => {
    _resetSentryFacadeForTests();
    mockSentryInit.mockClear();
    mockSentryCaptureException.mockClear();
    shouldFailSentryInitImport = false;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  afterEach(() => {
    _resetSentryFacadeForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("is a no-op when gate is off (DEV=true or missing VITE_SENTRY_DSN)", () => {
    // Case 1: DEV=true even with DSN set
    vi.stubEnv("DEV", true);
    vi.stubEnv("VITE_SENTRY_DSN", "https://key@o1.ingest.us.sentry.io/1");

    const addListenerSpy = vi.spyOn(window, "addEventListener");
    installEarlyErrorCapture();
    captureException(new Error("boom with ghp_secret123"));
    startSentryLoad();

    expect(addListenerSpy).not.toHaveBeenCalledWith("error", expect.any(Function));
    expect(_getSentryQueueForTests()).toHaveLength(0);
    expect(mockSentryInit).not.toHaveBeenCalled();

    // Case 2: DEV=false but DSN empty
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_SENTRY_DSN", "");
    installEarlyErrorCapture();
    captureException(new Error("boom"));
    startSentryLoad();

    expect(_getSentryQueueForTests()).toHaveLength(0);
    expect(mockSentryInit).not.toHaveBeenCalled();
    addListenerSpy.mockRestore();
  });

  it("scrubs error message and stack at enqueue time before SDK init", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_SENTRY_DSN", "https://key@o1.ingest.us.sentry.io/1");

    const rawErr = new TypeError(
      "Request failed with ghp_supersecrettoken123 and Bearer my_jwt_token_abc",
    );
    rawErr.stack =
      "TypeError: Request failed with ghp_supersecrettoken123\n    at fetch (https://gh.gordoncode.dev/cb?code=oauth_code_1&refresh_token=rt_secret_2&sealed_refresh_token=sealed_val_3:10:5)";

    captureException(rawErr, { tags: { source: "pat-validation" } });

    const queue = _getSentryQueueForTests();
    expect(queue).toHaveLength(1);
    const queued = queue[0];
    expect(queued.error).not.toBe(rawErr);
    expect(queued.error.name).toBe("TypeError");
    expect(queued.error.message).toBe(
      "Request failed with ghp_[REDACTED] and Bearer [REDACTED]",
    );
    expect(queued.error.message).not.toContain("supersecrettoken123");
    expect(queued.error.message).not.toContain("my_jwt_token_abc");
    expect(queued.error.stack).toContain("ghp_[REDACTED]");
    expect(queued.error.stack).toContain("code=[REDACTED]");
    expect(queued.error.stack).toContain("refresh_token=[REDACTED]");
    expect(queued.error.stack).toContain("sealed_refresh_token=[REDACTED]");
    expect(queued.hint).toEqual({ tags: { source: "pat-validation" } });

    // Non-Error values are also converted to scrubbed Error instances
    captureException("raw string failure with ghu_secret999");
    expect(queue[1].error.message).toBe("raw string failure with ghu_[REDACTED]");
  });

  it("caps the pre-init queue at 20 entries, dropping the oldest", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_SENTRY_DSN", "https://key@o1.ingest.us.sentry.io/1");

    for (let i = 1; i <= 25; i++) {
      captureException(new Error(`error-${i}`), { tags: { seq: String(i) } });
    }

    const queue = _getSentryQueueForTests();
    expect(queue).toHaveLength(20);
    expect(queue[0].error.message).toBe("error-6");
    expect(queue[19].error.message).toBe("error-25");
  });

  it("drains pre-init queue in FIFO order after idle load and forwards subsequent captures directly", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_SENTRY_DSN", "https://key@o1.ingest.us.sentry.io/1");

    let idleCb: (() => void) | null = null;
    vi.stubGlobal("requestIdleCallback", vi.fn((cb: () => void) => {
      idleCb = cb;
      return 1;
    }));

    captureException(new Error("first ghp_tok1"), { tags: { order: "1" } });
    captureException(new Error("second ghp_tok2"), { tags: { order: "2" } });

    startSentryLoad();
    expect(idleCb).not.toBeNull();
    idleCb!();

    await vi.waitFor(() => {
      expect(mockSentryInit).toHaveBeenCalledOnce();
      expect(mockSentryCaptureException).toHaveBeenCalledTimes(2);
    });

    expect(_getSentryQueueForTests()).toHaveLength(0);
    expect((mockSentryCaptureException.mock.calls[0][0] as Error).message).toBe(
      "first ghp_[REDACTED]",
    );
    expect(mockSentryCaptureException.mock.calls[0][1]).toEqual({
      tags: { order: "1" },
    });
    expect((mockSentryCaptureException.mock.calls[1][0] as Error).message).toBe(
      "second ghp_[REDACTED]",
    );
    expect(mockSentryCaptureException.mock.calls[1][1]).toEqual({
      tags: { order: "2" },
    });

    // Subsequent capture after init forwards directly without queueing
    const postInitErr = new Error("post-init error");
    captureException(postInitErr, { tags: { order: "3" } });
    expect(_getSentryQueueForTests()).toHaveLength(0);
    expect(mockSentryCaptureException).toHaveBeenCalledTimes(3);
    expect(mockSentryCaptureException.mock.calls[2][0]).toBe(postInitErr);
    expect(mockSentryCaptureException.mock.calls[2][1]).toEqual({
      tags: { order: "3" },
    });
  });

  it("forwards mechanism from reportBoundaryError", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_SENTRY_DSN", "https://key@o1.ingest.us.sentry.io/1");
    vi.useFakeTimers();

    const boundaryErr = new Error("route render crash");
    reportBoundaryError(boundaryErr);

    startSentryLoad();
    vi.advanceTimersByTime(2000);

    await vi.waitFor(() => {
      expect(mockSentryCaptureException).toHaveBeenCalledOnce();
    });

    expect(mockSentryCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "route render crash" }),
      {
        mechanism: {
          handled: true,
          type: "auto.function.solid.error_boundary",
        },
      },
    );
  });

  it("preserves tags.source on drained pre-init captures so beforeSendHandler drops background poll fetch disconnects", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_SENTRY_DSN", "https://key@o1.ingest.us.sentry.io/1");
    vi.useFakeTimers();

    captureException(new TypeError("Failed to fetch"), {
      tags: { source: "poll-cycle" },
    });

    startSentryLoad();
    vi.advanceTimersByTime(2000);

    await vi.waitFor(() => {
      expect(mockSentryCaptureException).toHaveBeenCalledOnce();
    });

    const [drainedErr, drainedHint] = mockSentryCaptureException.mock.calls[0] as [
      Error,
      { tags?: Record<string, string> },
    ];
    expect(drainedHint).toEqual({ tags: { source: "poll-cycle" } });

    // Simulate Sentry constructing the ErrorEvent with the forwarded hint tags
    const simulatedEvent = {
      tags: drainedHint.tags,
      exception: {
        values: [{ type: drainedErr.name, value: drainedErr.message }],
      },
    };
    expect(beforeSendHandler(simulatedEvent as never)).toBeNull();
  });

  it("enqueues synchronous window error and unhandledrejection events fired before startSentryLoad and removes listeners after init", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_SENTRY_DSN", "https://key@o1.ingest.us.sentry.io/1");
    vi.useFakeTimers();

    const removeSpy = vi.spyOn(window, "removeEventListener");
    installEarlyErrorCapture();
    // Calling twice is idempotent
    installEarlyErrorCapture();

    const earlyErr = new Error("early window error ghp_secret1");
    window.dispatchEvent(new ErrorEvent("error", { error: earlyErr, message: earlyErr.message }));

    const rejectionEvent = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejectionEvent, "reason", {
      value: new Error("early unhandled rejection gho_secret2"),
    });
    window.dispatchEvent(rejectionEvent);

    expect(_getSentryQueueForTests()).toHaveLength(2);
    expect(_getSentryQueueForTests()[0].error.message).toBe(
      "early window error ghp_[REDACTED]",
    );
    expect(_getSentryQueueForTests()[1].error.message).toBe(
      "early unhandled rejection gho_[REDACTED]",
    );

    startSentryLoad();
    vi.advanceTimersByTime(2000);

    await vi.waitFor(() => {
      expect(mockSentryCaptureException).toHaveBeenCalledTimes(2);
    });

    expect(removeSpy).toHaveBeenCalledWith("error", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("unhandledrejection", expect.any(Function));
    removeSpy.mockRestore();
  });

  it("handles sentry-init failure gracefully by warning once and never throwing", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_SENTRY_DSN", "https://key@o1.ingest.us.sentry.io/1");
    vi.useFakeTimers();

    shouldFailSentryInitImport = true;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    installEarlyErrorCapture();
    captureException(new Error("queued before failed load"));
    startSentryLoad();
    vi.advanceTimersByTime(2000);

    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledOnce();
    });

    expect(warnSpy).toHaveBeenCalledWith(
      "[app] Failed to load Sentry SDK:",
      expect.any(Error),
    );
    expect(mockSentryCaptureException).not.toHaveBeenCalled();

    // Queue remains capped at 20 even if more errors arrive after failed load
    for (let i = 0; i < 30; i++) {
      captureException(new Error(`post-fail-${i}`));
    }
    expect(_getSentryQueueForTests()).toHaveLength(20);

    warnSpy.mockRestore();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handle401SlowPath, type Auth401Deps } from "../../src/app/stores/auth-401";

// The lazily imported status module is unavailable (chunk failed to load), so
// verification must still run all checks and expire on a confirmed 401.
vi.mock("../../src/app/services/github-status", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

const mockCaptureException = vi.fn();
vi.mock("../../src/app/lib/sentry-facade", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const mockPushNotification = vi.fn();
vi.mock("../../src/app/lib/errors", () => ({
  pushNotification: (...args: unknown[]) => mockPushNotification(...args),
}));

function makeDeps(fetchUserCheck: () => Promise<Response>) {
  const deps = {
    isCurrentSession: () => true,
    fetchUserCheck,
    parseGitHubUserPayload: () => null,
    clearAuthOutageSuspension: vi.fn<() => void>(),
    getOutageSuspendStartedAt: () => null,
    setOutageSuspendStartedAt: vi.fn<(ts: number) => void>(),
    getAuthMethod: () => "pat" as const,
    expireToken: vi.fn<() => void>(),
    redirectToLogin: vi.fn<() => void>(),
  } satisfies Auth401Deps;
  return deps;
}

describe("handle401SlowPath when the github-status chunk fails to load", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockCaptureException.mockReset();
    mockPushNotification.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs both retries, expires the token, redirects, and tags apiRequestsStatus 'unknown'", async () => {
    const fetchUserCheck = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const deps = makeDeps(fetchUserCheck);

    const p = handle401SlowPath("runtime", new AbortController().signal, deps, { endpointKind: "rest" });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await p).toEqual({ outcome: "expired" });
    expect(fetchUserCheck).toHaveBeenCalledTimes(2);
    expect(deps.expireToken).toHaveBeenCalledOnce();
    expect(deps.redirectToLogin).toHaveBeenCalledOnce();
    expect(mockPushNotification).not.toHaveBeenCalled();
    const [, opts] = mockCaptureException.mock.calls[0] as [Error, { tags: Record<string, string> }];
    expect(opts.tags.apiRequestsStatus).toBe("unknown");
    expect(opts.tags.authMethod).toBe("pat");
  });

  it("validate mode expires without redirecting", async () => {
    const deps = makeDeps(vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    const p = handle401SlowPath("validate", new AbortController().signal, deps);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await p).toEqual({ outcome: "expired" });
    expect(deps.expireToken).toHaveBeenCalledOnce();
    expect(deps.redirectToLogin).not.toHaveBeenCalled();
  });
});

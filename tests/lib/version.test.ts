import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  APP_VERSION,
  GIT_SHA,
  BUILD_TIME,
  displayVersion,
  getAppVersion,
  VersionInfoSchema,
  updateAvailable,
  checkForUpdate,
  reloadOncePerTarget,
  startVersionWatch,
  VERSION_WATCH_INITIAL_DELAY_MS,
  _setAppVersionForTests,
  _setGitShaForTests,
  _resetVersionStateForTests,
} from "../../src/app/lib/version";

function makeJsonResponse(
  body: unknown,
  options?: { status?: number; contentType?: string },
): Response {
  const status = options?.status ?? 200;
  const contentType = options?.contentType ?? "application/json; charset=utf-8";
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
}

describe("version metadata", () => {
  beforeEach(() => {
    _resetVersionStateForTests();
  });

  afterEach(() => {
    _resetVersionStateForTests();
    vi.useRealTimers();
  });

  it("exposes build-time constants from Vite defines", () => {
    expect(APP_VERSION).toBe("0.1.0");
    expect(GIT_SHA).toBe("abcdef123456");
    expect(BUILD_TIME).toBe("2026-01-01T00:00:00.000Z");
  });

  it("formats displayVersion() as <APP_VERSION>+<7-char GIT_SHA>", () => {
    expect(displayVersion()).toBe(`${APP_VERSION}+${GIT_SHA.slice(0, 7)}`);
    expect(displayVersion()).toBe("0.1.0+abcdef1");
  });

  it("getAppVersion() tracks the running build version and the test override resets", () => {
    expect(getAppVersion()).toBe(APP_VERSION);
    _setAppVersionForTests("9.9.9");
    expect(getAppVersion()).toBe("9.9.9");
    expect(displayVersion()).toBe("9.9.9+abcdef1");
    _resetVersionStateForTests();
    expect(getAppVersion()).toBe(APP_VERSION);
  });

  describe("VersionInfoSchema", () => {
    it("accepts valid version metadata with hex SHA or 'dev'", () => {
      const validHex = VersionInfoSchema.safeParse({
        version: "0.1.1",
        sha: "1234567890ab",
        builtAt: "2026-01-02T00:00:00.000Z",
      });
      expect(validHex.success).toBe(true);

      const validDev = VersionInfoSchema.safeParse({
        version: "0.1.1",
        sha: "dev",
        builtAt: "2026-01-02T00:00:00.000Z",
      });
      expect(validDev.success).toBe(true);
    });

    it("rejects oversized strings or invalid SHA formats", () => {
      expect(
        VersionInfoSchema.safeParse({
          version: "v".repeat(33),
          sha: "1234567890ab",
          builtAt: "2026-01-02T00:00:00.000Z",
        }).success,
      ).toBe(false);

      expect(
        VersionInfoSchema.safeParse({
          version: "0.1.1",
          sha: "not-a-hex-sha",
          builtAt: "2026-01-02T00:00:00.000Z",
        }).success,
      ).toBe(false);

      expect(
        VersionInfoSchema.safeParse({
          version: "0.1.1",
          sha: "1234567890ab",
          builtAt: "t".repeat(41),
        }).success,
      ).toBe(false);
    });
  });

  describe("checkForUpdate", () => {
    it("leaves updateAvailable null when remote SHA matches local GIT_SHA", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        makeJsonResponse({
          version: "0.1.0",
          sha: GIT_SHA,
          builtAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await checkForUpdate();

      expect(fetchMock).toHaveBeenCalledWith("/version.json", {
        cache: "no-store",
        credentials: "same-origin",
      });
      expect(updateAvailable()).toBeNull();
    });

    it("sets updateAvailable when remote SHA differs from local GIT_SHA", async () => {
      const remoteInfo = {
        version: "0.1.1",
        sha: "fedcba987654",
        builtAt: "2026-01-02T12:00:00.000Z",
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeJsonResponse(remoteInfo)));

      await checkForUpdate();

      expect(updateAvailable()).toEqual(remoteInfo);
    });

    it("clears updateAvailable when a later check reports the running build again", async () => {
      const remoteInfo = {
        version: "0.1.1",
        sha: "fedcba987654",
        builtAt: "2026-01-02T12:00:00.000Z",
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeJsonResponse(remoteInfo)));
      await checkForUpdate();
      expect(updateAvailable()).toEqual(remoteInfo);

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          makeJsonResponse({
            version: "0.1.0",
            sha: GIT_SHA,
            builtAt: "2026-01-01T00:00:00.000Z",
          }),
        ),
      );
      await checkForUpdate();
      expect(updateAvailable()).toBeNull();
    });

    it("keeps a flagged update when a later response is unusable", async () => {
      const remoteInfo = {
        version: "0.1.1",
        sha: "fedcba987654",
        builtAt: "2026-01-02T12:00:00.000Z",
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeJsonResponse(remoteInfo)));
      await checkForUpdate();

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
      await checkForUpdate();
      expect(updateAvailable()).toEqual(remoteInfo);

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          makeJsonResponse({ version: "0.1.1", sha: "dev", builtAt: "2026-01-02T12:00:00.000Z" }),
        ),
      );
      await checkForUpdate();
      expect(updateAvailable()).toEqual(remoteInfo);
    });

    it("ignores non-OK HTTP responses and text/html SPA fallbacks", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          makeJsonResponse(
            { version: "0.1.1", sha: "fedcba987654", builtAt: "2026-01-02T12:00:00.000Z" },
            { status: 404 },
          ),
        ),
      );
      await checkForUpdate();
      expect(updateAvailable()).toBeNull();

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          makeJsonResponse("<!doctype html><html></html>", {
            status: 200,
            contentType: "text/html; charset=utf-8",
          }),
        ),
      );
      await checkForUpdate();
      expect(updateAvailable()).toBeNull();

      const headerlessRes = new Response(
        JSON.stringify({
          version: "0.1.1",
          sha: "fedcba987654",
          builtAt: "2026-01-02T12:00:00.000Z",
        }),
        { status: 200 },
      );
      headerlessRes.headers.delete("content-type");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(headerlessRes));
      await checkForUpdate();
      expect(updateAvailable()).toBeNull();
    });

    it("compares 12-char SHA prefixes case-insensitively", async () => {
      _setGitShaForTests("ABCDEF1234567890ABCDEF1234567890ABCDEF12");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          makeJsonResponse({
            version: "0.1.1",
            sha: "abcdef123456",
            builtAt: "2026-01-02T12:00:00.000Z",
          }),
        ),
      );
      await checkForUpdate();
      expect(updateAvailable()).toBeNull();
    });

    it("ignores malformed JSON, schema failures, and network errors", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          makeJsonResponse("{invalid-json", {
            status: 200,
            contentType: "application/json",
          }),
        ),
      );
      await checkForUpdate();
      expect(updateAvailable()).toBeNull();

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          makeJsonResponse({
            version: "0.1.1",
            sha: "<script>alert(1)</script>",
            builtAt: "2026-01-02T12:00:00.000Z",
          }),
        ),
      );
      await checkForUpdate();
      expect(updateAvailable()).toBeNull();

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
      await checkForUpdate();
      expect(updateAvailable()).toBeNull();
    });

    it("never flags an update when local GIT_SHA or remote SHA is 'dev'", async () => {
      _setGitShaForTests("dev");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          makeJsonResponse({
            version: "0.1.1",
            sha: "fedcba987654",
            builtAt: "2026-01-02T12:00:00.000Z",
          }),
        ),
      );
      await checkForUpdate();
      expect(updateAvailable()).toBeNull();

      _setGitShaForTests(GIT_SHA);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          makeJsonResponse({
            version: "0.1.1",
            sha: "dev",
            builtAt: "2026-01-02T12:00:00.000Z",
          }),
        ),
      );
      await checkForUpdate();
      expect(updateAvailable()).toBeNull();
    });

    it("coalesces concurrent checkForUpdate() calls into a single in-flight fetch", async () => {
      let resolveFetch!: (res: Response) => void;
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const p1 = checkForUpdate();
      const p2 = checkForUpdate();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      resolveFetch(
        makeJsonResponse({
          version: "0.1.1",
          sha: "fedcba987654",
          builtAt: "2026-01-02T12:00:00.000Z",
        }),
      );
      await Promise.all([p1, p2]);
      expect(updateAvailable()?.sha).toBe("fedcba987654");
    });
  });

  describe("reloadOncePerTarget", () => {
    it("returns true on first reload for a SHA, false on repeat for same SHA, and true for a new SHA", () => {
      expect(reloadOncePerTarget("111111111111")).toBe(true);
      expect(reloadOncePerTarget("111111111111")).toBe(false);
      expect(reloadOncePerTarget("222222222222")).toBe(true);
      expect(reloadOncePerTarget("222222222222")).toBe(false);
    });

    it("returns false for empty or 'dev' SHAs", () => {
      expect(reloadOncePerTarget("")).toBe(false);
      expect(reloadOncePerTarget("dev")).toBe(false);
    });

    it("normalizes SHAs to 12 characters and returns false if sessionStorage throws", () => {
      expect(reloadOncePerTarget("abcdef1234567890abcdef1234567890abcdef12")).toBe(true);
      expect(reloadOncePerTarget("abcdef123456")).toBe(false);

      const origGetItem = sessionStorage.getItem.bind(sessionStorage);
      vi.spyOn(sessionStorage, "getItem").mockImplementation(() => {
        throw new DOMException("Storage disabled", "SecurityError");
      });
      expect(reloadOncePerTarget("999999999999")).toBe(false);
      vi.restoreAllMocks();
      Object.defineProperty(sessionStorage, "getItem", {
        value: origGetItem,
        configurable: true,
        writable: true,
      });
      expect(reloadOncePerTarget("999999999999")).toBe(true);
    });
  });

  describe("startVersionWatch", () => {
    it("cancels the initial 30s timer if stopped before the delay elapses", async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockResolvedValue(
        makeJsonResponse({
          version: "0.1.0",
          sha: GIT_SHA,
          builtAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const stop = startVersionWatch();
      stop();

      await vi.advanceTimersByTimeAsync(VERSION_WATCH_INITIAL_DELAY_MS * 2);
      expect(fetchMock).not.toHaveBeenCalled();
    });
    it("triggers checkForUpdate after 30s and on visibilitychange to visible, and stops after cleanup", async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockResolvedValue(
        makeJsonResponse({
          version: "0.1.0",
          sha: GIT_SHA,
          builtAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const stop = startVersionWatch();
      expect(fetchMock).not.toHaveBeenCalled();

      // Advance to 30s initial check
      await vi.advanceTimersByTimeAsync(VERSION_WATCH_INITIAL_DELAY_MS);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Hidden visibilitychange should not trigger
      Object.defineProperty(document, "visibilityState", {
        value: "hidden",
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Visible visibilitychange should trigger
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Cleanup removes listener
      stop();
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});

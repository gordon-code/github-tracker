import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reloadOnceForStaleChunk } from "../../src/app/lib/chunk-reload";

const KEY = "github-tracker:chunk-reload";

describe("reloadOnceForStaleChunk", () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    sessionStorage.clear();
    reload = vi.fn();
    vi.stubGlobal("location", { reload });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("reloads and records the time on the first call", () => {
    expect(reloadOnceForStaleChunk()).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(KEY)).toBe("1000000");
  });

  it("does not reload again within the 10s guard window (inclusive)", () => {
    reloadOnceForStaleChunk();
    vi.setSystemTime(1_000_000 + 10_000);
    expect(reloadOnceForStaleChunk()).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reloads again once the guard window has passed", () => {
    reloadOnceForStaleChunk();
    vi.setSystemTime(1_000_000 + 10_001);
    expect(reloadOnceForStaleChunk()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("treats an unparseable stored value as expired and reloads", () => {
    sessionStorage.setItem(KEY, "not-a-number");
    expect(reloadOnceForStaleChunk()).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });
});

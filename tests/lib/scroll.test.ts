import { describe, it, expect, vi, afterEach } from "vitest";
import { withScrollLock, withFlipAnimation } from "../../src/app/lib/scroll";

describe("withScrollLock", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.scrollTop = 0;
  });

  it("restores scroll position after fn() completes", () => {
    document.documentElement.scrollTop = 500;
    vi.spyOn(window, "scrollTo");

    withScrollLock(() => {});

    expect(window.scrollTo).toHaveBeenCalledWith(0, 500);
  });

  it("restores scroll position even when fn() throws", () => {
    document.documentElement.scrollTop = 300;
    vi.spyOn(window, "scrollTo");

    expect(() =>
      withScrollLock(() => { throw new Error("boom"); })
    ).toThrow("boom");

    expect(window.scrollTo).toHaveBeenCalledWith(0, 300);
  });
});

describe("withFlipAnimation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.scrollTop = 0;
  });

  it("falls back to withScrollLock when prefers-reduced-motion is set", () => {
    document.documentElement.scrollTop = 400;
    vi.spyOn(window, "scrollTo");
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);

    withFlipAnimation(() => {});

    expect(window.scrollTo).toHaveBeenCalledWith(0, 400);
  });

  it("calls fn() without scrollTo when no elements have data-repo-group (no deltas)", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    vi.spyOn(window, "scrollTo");
    const fn = vi.fn();

    withFlipAnimation(fn);

    expect(fn).toHaveBeenCalledOnce();
    // No data-repo-group elements → no deltas → no scrollTo (FLIP is a no-op)
    expect(window.scrollTo).not.toHaveBeenCalled();
  });
});

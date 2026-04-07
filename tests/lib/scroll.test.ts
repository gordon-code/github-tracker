import { describe, it, expect, vi, afterEach } from "vitest";
import { withScrollLock, withFlipAnimation } from "../../src/app/lib/scroll";

describe("withScrollLock", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  });

  it("restores scroll position after fn() completes", () => {
    Object.defineProperty(window, "scrollY", { value: 500, configurable: true });
    vi.spyOn(window, "scrollTo");

    withScrollLock(() => {});

    expect(window.scrollTo).toHaveBeenCalledWith(0, 500);
  });

  it("restores scroll position even when fn() throws", () => {
    Object.defineProperty(window, "scrollY", { value: 300, configurable: true });
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
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  });

  it("falls back to withScrollLock when prefers-reduced-motion is set", () => {
    Object.defineProperty(window, "scrollY", { value: 400, configurable: true });
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

  it("reads all rects before scrollTo (no layout thrash), then animates", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);

    // Track call order to verify reads-before-writes
    const callOrder: string[] = [];
    vi.spyOn(window, "scrollTo").mockImplementation(() => { callOrder.push("scrollTo"); });

    let rafCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallback = cb;
      return 0;
    });

    const elA = document.createElement("div");
    elA.dataset.repoGroup = "org/repo-a";
    const elB = document.createElement("div");
    elB.dataset.repoGroup = "org/repo-b";
    document.body.appendChild(elA);
    document.body.appendChild(elB);

    const beforeRectA = { top: 100, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    const beforeRectB = { top: 200, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    const afterRectA  = { top: 200, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    const afterRectB  = { top: 100, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;

    vi.spyOn(elA, "getBoundingClientRect").mockImplementation(() => {
      callOrder.push("rectA");
      // First call returns before, second returns after
      return callOrder.filter(c => c === "rectA").length <= 1 ? beforeRectA : afterRectA;
    });
    vi.spyOn(elB, "getBoundingClientRect").mockImplementation(() => {
      callOrder.push("rectB");
      return callOrder.filter(c => c === "rectB").length <= 1 ? beforeRectB : afterRectB;
    });

    const animateA = vi.fn().mockReturnValue({ finished: Promise.resolve() });
    const animateB = vi.fn().mockReturnValue({ finished: Promise.resolve() });
    elA.animate = animateA;
    elB.animate = animateB;

    // scrollY is 300, no drift (stays 300 in rAF since we mock it)
    Object.defineProperty(window, "scrollY", { value: 300, configurable: true });

    withFlipAnimation(() => {});

    expect(rafCallback).not.toBeNull();
    expect(animateA).not.toHaveBeenCalled();

    rafCallback!(0);

    // Verify reads-before-writes: all getBoundingClientRect calls happen before scrollTo
    const scrollToIdx = callOrder.indexOf("scrollTo");
    const lastRectIdx = Math.max(
      callOrder.lastIndexOf("rectA"),
      callOrder.lastIndexOf("rectB"),
    );
    expect(lastRectIdx).toBeLessThan(scrollToIdx);

    expect(window.scrollTo).toHaveBeenCalledWith(0, 300);

    // scrollDrift is 0 (scrollY unchanged), so dy = old.top - now.top - 0
    expect(animateA).toHaveBeenCalledWith(
      [{ transform: "translateY(-100px)" }, { transform: "translateY(0)" }],
      { duration: 200, easing: "ease-in-out" },
    );
    expect(animateB).toHaveBeenCalledWith(
      [{ transform: "translateY(100px)" }, { transform: "translateY(0)" }],
      { duration: 200, easing: "ease-in-out" },
    );

    document.body.removeChild(elA);
    document.body.removeChild(elB);
  });

  it("skips elements whose position delta is less than 1px", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);

    let rafCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallback = cb;
      return 0;
    });

    const el = document.createElement("div");
    el.dataset.repoGroup = "org/repo-stable";
    document.body.appendChild(el);

    const stableRect = { top: 50, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(stableRect);

    const animateSpy = vi.fn();
    el.animate = animateSpy;

    withFlipAnimation(() => {});
    rafCallback!(0);

    expect(animateSpy).not.toHaveBeenCalled();

    document.body.removeChild(el);
  });
});

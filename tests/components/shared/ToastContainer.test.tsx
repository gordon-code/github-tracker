import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import {
  pushNotification,
  clearNotifications,
  addMutedSource,
  clearMutedSources,
  dismissError,
  getNotifications,
} from "../../../src/app/lib/errors";
import ToastContainer, { resetToastState } from "../../../src/app/components/shared/ToastContainer";

// Mirrors the private TOASTED_MESSAGES_KEY constant in ToastContainer.tsx —
// hardcoded here the same way tests/stores/config.test.ts hardcodes STORAGE_KEY.
const TOASTED_MESSAGES_KEY = "github-tracker:toasted-messages";

// Mock the auth store's onAuthCleared so the "clears on logout" test can
// directly invoke the callback ToastContainer registers, without pulling in
// clearAuth()'s broader logout side effects (localStorage, IndexedDB,
// Sentry) — mirrors the capture pattern in tests/components/DashboardPage.test.tsx.
// vi.hoisted() is required here (unlike that file) because this file imports
// ToastContainer statically at the top, so the mock factory runs — and calls
// onAuthCleared(resetToastState) via ToastContainer's module-scope
// registration — before a plain top-level `const` would finish initializing.
const { authClearCallbacks } = vi.hoisted(() => ({ authClearCallbacks: [] as (() => void)[] }));
vi.mock("../../../src/app/stores/auth", () => ({
  onAuthCleared: vi.fn((cb: () => void) => {
    authClearCallbacks.push(cb);
  }),
}));

beforeEach(() => {
  clearNotifications();
  clearMutedSources();
  resetToastState();
  vi.useFakeTimers();
  // Ensure matchMedia returns non-reduced-motion
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ToastContainer", () => {
  it("renders no toasts when notification store is empty", () => {
    render(() => <ToastContainer />);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("renders a toast when pushNotification is called", () => {
    render(() => <ToastContainer />);
    pushNotification("api", "Something failed", "error");
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain("api");
    expect(screen.getByRole("alert").textContent).toContain("Something failed");
  });

  it("shows source and message in toast", () => {
    render(() => <ToastContainer />);
    pushNotification("search", "Results incomplete", "warning");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("search");
    expect(alert.textContent).toContain("Results incomplete");
  });

  it("applies alert-error class for error severity", () => {
    render(() => <ToastContainer />);
    pushNotification("api", "Error happened", "error");
    const alert = screen.getByRole("alert");
    expect(alert.className).toContain("alert-error");
  });

  it("applies alert-warning class for warning severity", () => {
    render(() => <ToastContainer />);
    pushNotification("search", "Warning here", "warning");
    const alert = screen.getByRole("alert");
    expect(alert.className).toContain("alert-warning");
  });

  it("applies alert-info class for info severity", () => {
    render(() => <ToastContainer />);
    pushNotification("graphql", "Info message", "info");
    const alert = screen.getByRole("alert");
    expect(alert.className).toContain("alert-info");
  });

  it("shows (will retry) for retryable notifications", () => {
    render(() => <ToastContainer />);
    pushNotification("api", "Network error", "error", true);
    expect(screen.getByRole("alert").textContent).toContain("(will retry)");
  });

  it("does not show (will retry) for non-retryable notifications", () => {
    render(() => <ToastContainer />);
    pushNotification("api", "Not found", "error", false);
    expect(screen.getByRole("alert").textContent).not.toContain("(will retry)");
  });

  it("manual dismiss removes toast when close button clicked", () => {
    render(() => <ToastContainer />);
    pushNotification("api", "Error", "error");
    expect(screen.queryAllByRole("alert")).toHaveLength(1);
    const dismissBtn = screen.getByLabelText("Dismiss notification");
    fireEvent.click(dismissBtn);
    // Toast starts dismiss animation, removed after 300ms
    vi.advanceTimersByTime(300);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("auto-dismisses error toasts after 10 seconds", () => {
    render(() => <ToastContainer />);
    pushNotification("api", "Error", "error");
    expect(screen.queryAllByRole("alert")).toHaveLength(1);
    // At 9999ms, still visible
    vi.advanceTimersByTime(9999);
    expect(screen.queryAllByRole("alert")).toHaveLength(1);
    // At 10s + 300ms animation delay, toast removed
    vi.advanceTimersByTime(1 + 300);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("auto-dismisses warning/info toasts after 5 seconds", () => {
    render(() => <ToastContainer />);
    pushNotification("search", "Warning", "warning");
    expect(screen.queryAllByRole("alert")).toHaveLength(1);
    vi.advanceTimersByTime(4999);
    expect(screen.queryAllByRole("alert")).toHaveLength(1);
    vi.advanceTimersByTime(1 + 300);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("coalesces a rapid burst of distinct messages from the same source, promoting the latest one once the window elapses", () => {
    render(() => <ToastContainer />);
    pushNotification("api", "First error", "error");
    expect(screen.queryAllByRole("alert")).toHaveLength(1);

    // Two more distinct messages arrive within the coalescing window (e.g. a
    // fast-ticking rate-limit retry countdown) — neither spawns/replaces the
    // visible toast immediately.
    vi.advanceTimersByTime(500);
    pushNotification("api", "Second error", "error");
    expect(screen.getByRole("alert").textContent).toContain("First error");

    vi.advanceTimersByTime(500);
    pushNotification("api", "Third error", "error");
    expect(screen.getByRole("alert").textContent).toContain("First error");

    // Once the coalescing window (3s from the first toast) elapses with no
    // further push, the LATEST suppressed value is automatically promoted —
    // a burst that never gets superseded doesn't get silently lost forever.
    vi.advanceTimersByTime(2001);
    expect(screen.queryAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toContain("Third error");
  });

  it("does not spuriously re-toast when a coalesced burst settles back to the already-displayed message", () => {
    render(() => <ToastContainer />);
    pushNotification("api", "State Alpha", "error");
    expect(screen.queryAllByRole("alert")).toHaveLength(1);

    // A different value arrives and is coalesced, then flaps back to the
    // original value (also coalesced) before the window elapses. Once the
    // window's trailing-edge check runs, the store's current value already
    // matches what's displayed — this must NOT trigger a spurious re-toast
    // or reset the auto-dismiss timer (errors.ts treats a push identical to
    // the store's current value as a no-op, so this path only reaches
    // ToastContainer via the same coalescing re-check machinery, not a new
    // store event).
    vi.advanceTimersByTime(500);
    pushNotification("api", "State Beta", "error");
    vi.advanceTimersByTime(300);
    pushNotification("api", "State Alpha", "error");
    expect(screen.getByRole("alert").textContent).toContain("State Alpha");

    vi.advanceTimersByTime(2201);
    expect(screen.queryAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toContain("State Alpha");

    // Confirm no restart occurred: the toast still dismisses on its ORIGINAL
    // 10s schedule from the very first push (500+300+2201+7299 = 10300),
    // not a schedule reset by a spurious re-check promotion.
    vi.advanceTimersByTime(7299);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("restarts the auto-dismiss timer when an update passes through once the coalescing window has elapsed", () => {
    render(() => <ToastContainer />);
    pushNotification("rate-limit", "Retrying in 5s", "warning");
    expect(screen.queryAllByRole("alert")).toHaveLength(1);

    // Exactly at the 3s coalescing window boundary, a fresh retry countdown
    // arrives for the same source and is allowed through — the toast must
    // get a full fresh dismiss window rather than inheriting the stale one.
    vi.advanceTimersByTime(3000);
    pushNotification("rate-limit", "Retrying in 3s", "warning");
    expect(screen.getByRole("alert").textContent).toContain("Retrying in 3s");

    // The ORIGINAL timer (scheduled at t=0 for 5000ms, i.e. due 2000ms from
    // here) would — if not cleared on update — fire its dismiss animation and
    // complete removal 300ms later (at 2300ms from here). Advance past that
    // point: the toast must still be fully present, not dismissed early.
    vi.advanceTimersByTime(2500);
    expect(screen.queryAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toContain("Retrying in 3s");

    // The fresh window (started at the update, t=3000) completes 5000ms +
    // 300ms animation delay after the update — 3000ms from the point above.
    vi.advanceTimersByTime(3000);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("treats a non-array but validly-parsed sessionStorage value as empty dedup state", () => {
    sessionStorage.setItem(TOASTED_MESSAGES_KEY, "42");
    render(() => <ToastContainer />);
    pushNotification("api", "First error", "error");
    expect(screen.queryAllByRole("alert")).toHaveLength(1);
  });

  it("drops malformed tuples from a parseable sessionStorage array without crashing, keeping well-formed entries", () => {
    sessionStorage.setItem(
      TOASTED_MESSAGES_KEY,
      JSON.stringify([
        ["api", 123],
        ["api"],
        ["not-a-tuple"],
        ["search", "Results incomplete"],
      ])
    );

    // Push the "search" notification before mount so it's already a currently-
    // active source on the component's first effect run — otherwise the
    // pruning pass (which clears dedup entries for sources with no active
    // notification) would wipe this preloaded entry before we can exercise it.
    pushNotification("search", "Results incomplete", "warning");

    expect(() => render(() => <ToastContainer />)).not.toThrow();

    // The well-formed "search" entry survived parsing and suppressed the
    // already-active, unchanged notification on mount.
    expect(screen.queryAllByRole("alert")).toHaveLength(0);

    // Malformed "api"/"not-a-tuple" entries were dropped — a fresh "api"
    // notification still toasts normally.
    pushNotification("api", "First error", "error");
    expect(screen.queryAllByRole("alert")).toHaveLength(1);
  });

  it("does not throw when sessionStorage contains invalid JSON, and toasts normally afterward", () => {
    sessionStorage.setItem(TOASTED_MESSAGES_KEY, "{not valid json");
    expect(() => render(() => <ToastContainer />)).not.toThrow();
    pushNotification("api", "First error", "error");
    expect(screen.queryAllByRole("alert")).toHaveLength(1);
  });

  it("muted source suppresses toast", () => {
    render(() => <ToastContainer />);
    addMutedSource("api");
    pushNotification("api", "Muted error", "error");
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("toast removed when notification dismissed from store", () => {
    render(() => <ToastContainer />);
    pushNotification("api", "Error", "error");
    expect(screen.queryAllByRole("alert")).toHaveLength(1);

    // Dismiss from store externally — toast should be removed
    const notifId = getNotifications()[0].id;
    dismissError(notifId);

    // Toast should be removed (store pruning path)
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("does not re-toast a still-active notification across a remount (e.g. dashboard -> settings -> dashboard nav)", () => {
    const first = render(() => <ToastContainer />);
    pushNotification("github-status", "Actions Outage", "error");
    expect(screen.queryAllByRole("alert")).toHaveLength(1);

    // Simulate navigating away: ToastContainer/Header only render inside
    // DashboardPage, so leaving /dashboard unmounts this component while the
    // notification (an ongoing outage) stays in the store, unchanged.
    first.unmount();
    expect(screen.queryAllByRole("alert")).toHaveLength(0);

    // Simulate navigating back: a fresh mount, same unchanged notification
    // still present in the store — must not replay the toast.
    render(() => <ToastContainer />);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("still toasts a genuinely new notification for the same source after a remount", () => {
    const first = render(() => <ToastContainer />);
    pushNotification("github-status", "Actions Outage", "error");
    expect(screen.queryAllByRole("alert")).toHaveLength(1);

    first.unmount();

    // A distinct incident (new message) resolves the prior one and starts —
    // must still surface as a toast even though this source was already
    // toasted once before the remount.
    pushNotification("github-status", "Issues Outage", "error");
    render(() => <ToastContainer />);
    const alerts = screen.queryAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toContain("Issues Outage");
  });

  it("does not re-toast after a simulated hard refresh (sessionStorage survives, in-memory state does not)", () => {
    const first = render(() => <ToastContainer />);
    pushNotification("github-status", "Actions Outage", "error");
    expect(screen.queryAllByRole("alert")).toHaveLength(1);
    first.unmount();

    // A hard refresh wipes the notification store itself (module-level state
    // resets), but NOT sessionStorage. Simulate that: clear the store the way
    // a fresh page load would leave it, then re-announce the same unchanged
    // outage on the next poll cycle after reload — exactly what
    // notifyTransitions() does today (it unconditionally re-pushes for any
    // still-active incident).
    clearNotifications();
    pushNotification("github-status", "Actions Outage", "error");

    render(() => <ToastContainer />);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("re-toasts once a source's notification clears and later recurs with the same text", () => {
    const first = render(() => <ToastContainer />);
    pushNotification("github-status", "Actions Outage", "error");
    expect(screen.queryAllByRole("alert")).toHaveLength(1);

    // Incident fully resolves — source drops out of the store entirely.
    const notifId = getNotifications()[0].id;
    dismissError(notifId);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);

    first.unmount();

    // A later, unrelated incident happens to have identical text — should
    // not be suppressed forever just because the same string was toasted once.
    pushNotification("github-status", "Actions Outage", "error");
    render(() => <ToastContainer />);
    expect(screen.queryAllByRole("alert")).toHaveLength(1);
  });

  it("coalesces correctly when toastedMessages starts pre-populated from a prior mount, not built fresh", () => {
    sessionStorage.setItem(TOASTED_MESSAGES_KEY, JSON.stringify([["api", "Old error"]]));
    // Keep the source's notification active so its persisted entry survives
    // the mount's pruning pass.
    pushNotification("api", "Old error", "error");

    render(() => <ToastContainer />);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);

    // A rapid burst of distinct messages arrives in THIS mount — lastToastedAt
    // starts empty (component-local) even though toastedMessages (the OTHER
    // map) started non-empty from sessionStorage; coalescing must still
    // engage correctly against the fresh map. Advance 1ms first so this
    // push's timestamp differs from the pre-mount "Old error" push — fake
    // timers don't advance on their own, and the effect only treats a push
    // as an update when its timestamp is strictly greater than the last seen.
    vi.advanceTimersByTime(1);
    pushNotification("api", "New error A", "error");
    expect(screen.getByRole("alert").textContent).toContain("New error A");

    vi.advanceTimersByTime(500);
    pushNotification("api", "New error B", "error");
    expect(screen.getByRole("alert").textContent).toContain("New error A");

    vi.advanceTimersByTime(2501);
    expect(screen.getByRole("alert").textContent).toContain("New error B");
  });

  it("prunes a persisted toastedMessages entry with no matching lastToastedAt entry when its source has no active notification", () => {
    sessionStorage.setItem(TOASTED_MESSAGES_KEY, JSON.stringify([["ghost", "Old message"]]));
    // No active notification for "ghost" — lastToastedAt never had an entry
    // for it either (it always starts empty on mount). The merged pruning
    // loop must still correctly prune a source present in only ONE of the
    // two maps.
    render(() => <ToastContainer />);
    expect(sessionStorage.getItem(TOASTED_MESSAGES_KEY)).toBe(JSON.stringify([]));

    // Confirms the entry was actually removed, not just hidden from view.
    pushNotification("ghost", "Old message", "warning");
    expect(screen.queryAllByRole("alert")).toHaveLength(1);
  });

  it("respects a mute applied during a pending coalescing window, skipping the trailing-edge promotion", () => {
    render(() => <ToastContainer />);
    pushNotification("api", "First error", "error");
    expect(screen.queryAllByRole("alert")).toHaveLength(1);

    // A distinct message arrives and is coalesced, scheduling a trailing
    // re-check for when the window elapses.
    vi.advanceTimersByTime(500);
    pushNotification("api", "Second error", "error");

    // The source is muted before the re-check fires.
    addMutedSource("api");

    // Once the window elapses, the re-check must honor the mute and skip
    // promoting the coalesced value — the original toast stays as-is.
    vi.advanceTimersByTime(2501);
    expect(screen.getByRole("alert").textContent).toContain("First error");
  });

  it("registers resetToastState with onAuthCleared so toast dedup state clears on logout", () => {
    render(() => <ToastContainer />);
    pushNotification("github-status", "Actions Outage", "error");
    expect(screen.queryAllByRole("alert")).toHaveLength(1);
    expect(sessionStorage.getItem(TOASTED_MESSAGES_KEY)).toContain("Actions Outage");

    // ToastContainer registers resetToastState with onAuthCleared at module
    // scope — confirm the registration actually happened (not just that the
    // module loaded without error), then simulate what clearAuth() does on
    // logout by invoking every captured callback.
    expect(authClearCallbacks.length).toBeGreaterThan(0);
    for (const cb of authClearCallbacks) cb();

    expect(sessionStorage.getItem(TOASTED_MESSAGES_KEY)).toBeNull();
  });
});

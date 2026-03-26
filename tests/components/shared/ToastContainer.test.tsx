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
import ToastContainer from "../../../src/app/components/shared/ToastContainer";

beforeEach(() => {
  clearNotifications();
  clearMutedSources();
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

  it("cooldown: no new toast within 60s for same source with different message", () => {
    render(() => <ToastContainer />);
    pushNotification("api", "First error", "error");
    expect(screen.queryAllByRole("alert")).toHaveLength(1);

    // Manually dismiss so toast is gone from screen
    const dismissBtn = screen.getByLabelText("Dismiss notification");
    fireEvent.click(dismissBtn);
    vi.advanceTimersByTime(300);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);

    // Push different message within 60s — should NOT show new toast (cooldown)
    pushNotification("api", "Second error", "error");
    expect(screen.queryAllByRole("alert")).toHaveLength(0);

    // Advance past cooldown (60s)
    vi.advanceTimersByTime(60_001);

    // Push again — should show toast now
    pushNotification("api", "Third error", "error");
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
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import {
  pushNotification,
  clearNotifications,
} from "../../../src/app/lib/errors";
import ToastContainer from "../../../src/app/components/shared/ToastContainer";

beforeEach(() => {
  clearNotifications();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ToastContainer", () => {
  it("renders no toasts when notification store is empty", () => {
    const { container } = render(() => <ToastContainer />);
    expect(container.querySelectorAll("[role='alert']")).toHaveLength(0);
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

  it("applies bg-red-50 class for error severity", () => {
    render(() => <ToastContainer />);
    pushNotification("api", "Error happened", "error");
    const alert = screen.getByRole("alert");
    expect(alert.className).toContain("bg-red-50");
  });

  it("applies bg-yellow-50 class for warning severity", () => {
    render(() => <ToastContainer />);
    pushNotification("search", "Warning here", "warning");
    const alert = screen.getByRole("alert");
    expect(alert.className).toContain("bg-yellow-50");
  });

  it("applies bg-blue-50 class for info severity", () => {
    render(() => <ToastContainer />);
    pushNotification("graphql", "Info message", "info");
    const alert = screen.getByRole("alert");
    expect(alert.className).toContain("bg-blue-50");
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

  it("manual dismiss starts dismiss animation and removes toast after delay", () => {
    const { container } = render(() => <ToastContainer />);
    pushNotification("api", "Error", "error");
    const dismissBtn = screen.getByLabelText("Dismiss notification");
    fireEvent.click(dismissBtn);
    // Should switch to animate-toast-out
    const alert = container.querySelector("[role='alert']");
    expect(alert?.className).toContain("animate-toast-out");
    // After 300ms, toast should be removed
    vi.advanceTimersByTime(300);
    expect(container.querySelectorAll("[role='alert']")).toHaveLength(0);
  });

  it("auto-dismisses error toasts after 10 seconds", () => {
    const { container } = render(() => <ToastContainer />);
    pushNotification("api", "Error", "error");
    expect(container.querySelectorAll("[role='alert']")).toHaveLength(1);
    // At 9999ms, still visible
    vi.advanceTimersByTime(9999);
    expect(container.querySelectorAll("[role='alert']")).toHaveLength(1);
    // At 10s + animation delay (300ms), should be gone
    vi.advanceTimersByTime(1 + 300);
    expect(container.querySelectorAll("[role='alert']")).toHaveLength(0);
  });

  it("auto-dismisses warning/info toasts after 5 seconds", () => {
    const { container } = render(() => <ToastContainer />);
    pushNotification("search", "Warning", "warning");
    expect(container.querySelectorAll("[role='alert']")).toHaveLength(1);
    vi.advanceTimersByTime(4999);
    expect(container.querySelectorAll("[role='alert']")).toHaveLength(1);
    vi.advanceTimersByTime(1 + 300);
    expect(container.querySelectorAll("[role='alert']")).toHaveLength(0);
  });

  it("cooldown: no new toast within 60s for same source with different message", () => {
    const { container } = render(() => <ToastContainer />);
    pushNotification("api", "First error", "error");
    expect(container.querySelectorAll("[role='alert']")).toHaveLength(1);

    // Manually dismiss so toast is gone from screen
    const dismissBtn = screen.getByLabelText("Dismiss notification");
    fireEvent.click(dismissBtn);
    vi.advanceTimersByTime(300);
    expect(container.querySelectorAll("[role='alert']")).toHaveLength(0);

    // Push different message within 60s — should NOT show new toast (cooldown)
    pushNotification("api", "Second error", "error");
    expect(container.querySelectorAll("[role='alert']")).toHaveLength(0);

    // Advance past cooldown (60s)
    vi.advanceTimersByTime(60_001);

    // Push again — should show toast now
    pushNotification("api", "Third error", "error");
    expect(container.querySelectorAll("[role='alert']")).toHaveLength(1);
  });
});

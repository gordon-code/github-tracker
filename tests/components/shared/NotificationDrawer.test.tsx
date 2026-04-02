import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import {
  pushNotification,
  clearNotifications,
  markAllAsRead,
  isMuted,
  clearMutedSources,
} from "../../../src/app/lib/errors";
import NotificationDrawer from "../../../src/app/components/shared/NotificationDrawer";

beforeEach(() => {
  clearNotifications();
  clearMutedSources();
  vi.useFakeTimers();
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderDrawer(open = true, onClose = vi.fn()) {
  const [isOpen, setIsOpen] = createSignal(open);
  const close = () => {
    onClose();
    setIsOpen(false);
  };
  const result = render(() => <NotificationDrawer open={isOpen()} onClose={close} />);
  return { ...result, onClose, setIsOpen };
}

describe("NotificationDrawer", () => {
  it("does not render dialog when open is false", () => {
    render(() => (
      <NotificationDrawer open={false} onClose={vi.fn()} />
    ));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders drawer with Notifications heading when open is true", () => {
    renderDrawer(true);
    vi.advanceTimersByTime(0);
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByText("Notifications")).toBeDefined();
  });

  it("shows notification items when store has notifications", () => {
    pushNotification("api", "Something failed", "error");
    renderDrawer(true);
    vi.advanceTimersByTime(0);
    expect(screen.getByText(/Something failed/)).toBeDefined();
    expect(screen.getByText(/api/)).toBeDefined();
    expect(screen.queryByText("(will retry)")).toBeNull();
  });

  it("shows newest notification first in the list", () => {
    pushNotification("first", "First message", "info");
    pushNotification("second", "Second message", "warning");
    renderDrawer(true);
    vi.advanceTimersByTime(0);
    const items = screen.getAllByRole("listitem");
    // Newest (second) should appear first
    expect(items[0].textContent).toContain("second");
    expect(items[1].textContent).toContain("first");
  });

  it("dismiss button on an item removes it from the list", () => {
    pushNotification("api", "Error A", "error");
    pushNotification("poll", "Error B", "error");
    renderDrawer(true);
    vi.advanceTimersByTime(0);
    const dismissBtns = screen.getAllByLabelText("Dismiss notification");
    expect(dismissBtns).toHaveLength(2);
    fireEvent.click(dismissBtns[0]);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("Mark all as read keeps notifications but removes unread styling", () => {
    pushNotification("api", "Unread error", "error");
    renderDrawer(true);
    vi.advanceTimersByTime(0);

    const items = screen.getAllByRole("listitem");
    expect(items[0].className).toContain("bg-info/10");

    fireEvent.click(screen.getByText("Mark all as read"));
    // Notifications still present
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    // Unread background class removed
    expect(screen.getAllByRole("listitem")[0].className).not.toContain("bg-info/10");
  });

  it("Dismiss all empties the list and mutes sources", () => {
    pushNotification("api", "Error", "error");
    pushNotification("search", "Warning", "warning");
    renderDrawer(true);
    vi.advanceTimersByTime(0);

    fireEvent.click(screen.getByText("Dismiss all"));
    // List is empty
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText("No notifications")).toBeDefined();
    // Sources are muted
    expect(isMuted("api")).toBe(true);
    expect(isMuted("search")).toBe(true);
  });

  it("calls onClose when overlay backdrop is clicked", () => {
    // Kobalte dismisses via document-level capture-phase pointerdown (createInteractOutside),
    // not an overlay click handler. data-testid targets the overlay because Dialog.Overlay
    // has no ARIA role to query by.
    const onClose = vi.fn();
    render(() => <NotificationDrawer open={true} onClose={onClose} />);
    vi.advanceTimersByTime(0);
    const overlay = screen.getByTestId("notification-overlay");
    fireEvent.pointerDown(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when X button is clicked", () => {
    const onClose = vi.fn();
    render(() => <NotificationDrawer open={true} onClose={onClose} />);
    vi.advanceTimersByTime(0);
    fireEvent.click(screen.getByLabelText("Close notifications"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows empty state text when no notifications", () => {
    renderDrawer(true);
    vi.advanceTimersByTime(0);
    expect(screen.getByText("No notifications")).toBeDefined();
  });

  it("unread notifications have bg-info/10 background class", () => {
    pushNotification("api", "Unread notification", "error");
    renderDrawer(true);
    vi.advanceTimersByTime(0);
    const item = screen.getByRole("listitem");
    expect(item.className).toContain("bg-info/10");
  });

  it("read notifications do not have bg-info/10 background class", () => {
    pushNotification("api", "Read notification", "error");
    markAllAsRead();
    renderDrawer(true);
    vi.advanceTimersByTime(0);
    const item = screen.getByRole("listitem");
    expect(item.className).not.toContain("bg-info/10");
  });

  it("has role=dialog and Close button with proper aria-label", () => {
    renderDrawer(true);
    vi.advanceTimersByTime(0);
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByLabelText("Close notifications")).toBeDefined();
  });

  it("Escape key calls onClose", () => {
    const onClose = vi.fn();
    render(() => <NotificationDrawer open={true} onClose={onClose} />);
    vi.advanceTimersByTime(0);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows retryable indicator when notification is retryable", () => {
    pushNotification("api", "Transient failure", "error", true);
    renderDrawer(true);
    vi.advanceTimersByTime(0);
    expect(screen.queryByText("(will retry)")).not.toBeNull();
  });

  it("marks dialog as closed when open transitions from true to false", () => {
    // solid-presence waits for animationend to unmount; happy-dom has no CSS engine
    // so the element stays in DOM with data-closed instead of being removed
    const { setIsOpen } = renderDrawer(true);
    vi.advanceTimersByTime(0);
    const dialog = screen.getByRole("dialog");
    expect(dialog.hasAttribute("data-closed")).toBe(false);
    setIsOpen(false);
    vi.advanceTimersByTime(0);
    expect(dialog.hasAttribute("data-closed")).toBe(true);
  });

  it("has accessible description for screen readers", () => {
    renderDrawer(true);
    vi.advanceTimersByTime(0);
    const dialog = screen.getByRole("dialog");
    const descId = dialog.getAttribute("aria-describedby");
    expect(descId).toBeTruthy();
    const descEl = document.getElementById(descId!);
    expect(descEl?.textContent).toContain("Recent system notifications and errors");
  });
});

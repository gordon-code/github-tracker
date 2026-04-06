import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { Tooltip, InfoTooltip } from "../../../src/app/components/shared/Tooltip";

describe("Tooltip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders children correctly", () => {
    render(() => (
      <Tooltip content="Tooltip text">
        <button type="button">Click me</button>
      </Tooltip>
    ));
    expect(screen.getByRole("button", { name: "Click me" })).toBeTruthy();
  });

  it("trigger has inline-flex class", () => {
    const { container } = render(() => (
      <Tooltip content="Tooltip text">
        <span>Child</span>
      </Tooltip>
    ));
    const trigger = container.querySelector("span.inline-flex");
    expect(trigger).not.toBeNull();
  });

  it("focusable prop adds tabindex='0' to trigger span", () => {
    const { container } = render(() => (
      <Tooltip content="Tooltip text" focusable>
        <span>Badge</span>
      </Tooltip>
    ));
    const trigger = container.querySelector("span.inline-flex");
    expect(trigger?.getAttribute("tabindex")).toBe("0");
  });

  it("without focusable, trigger span has no tabindex", () => {
    const { container } = render(() => (
      <Tooltip content="Tooltip text">
        <span>Badge</span>
      </Tooltip>
    ));
    const trigger = container.querySelector("span.inline-flex");
    expect(trigger?.hasAttribute("tabindex")).toBe(false);
  });

  it("tooltip content is not visible before hover", () => {
    render(() => (
      <Tooltip content="tooltip text">
        <span>Trigger</span>
      </Tooltip>
    ));
    expect(document.body.textContent).not.toContain("tooltip text");
  });

  it("shows tooltip content after 300ms hover delay", () => {
    const { container } = render(() => (
      <Tooltip content="tooltip text">
        <span>Trigger</span>
      </Tooltip>
    ));
    const trigger = container.querySelector("span.inline-flex")!;
    fireEvent.pointerEnter(trigger);
    // Content should not be visible before delay fires
    expect(document.body.textContent).not.toContain("tooltip text");
    vi.advanceTimersByTime(300);
    expect(document.body.textContent).toContain("tooltip text");
  });

  it("cancels tooltip if pointer leaves before 300ms delay", () => {
    const { container } = render(() => (
      <Tooltip content="tooltip text">
        <span>Trigger</span>
      </Tooltip>
    ));
    const trigger = container.querySelector("span.inline-flex")!;
    fireEvent.pointerEnter(trigger);
    vi.advanceTimersByTime(150);
    fireEvent.pointerLeave(trigger);
    vi.advanceTimersByTime(300);
    expect(document.body.textContent).not.toContain("tooltip text");
  });

  it("closes tooltip state when pointer leaves after it is visible", () => {
    const { container } = render(() => (
      <Tooltip content="tooltip text">
        <span>Trigger</span>
      </Tooltip>
    ));
    const trigger = container.querySelector("span.inline-flex")!;
    fireEvent.pointerEnter(trigger);
    vi.advanceTimersByTime(300);
    expect(trigger.getAttribute("data-expanded")).toBe("");
    fireEvent.pointerLeave(trigger);
    expect(trigger.hasAttribute("data-expanded")).toBe(false);
  });

  it("shows tooltip on focusIn (keyboard access)", () => {
    const { container } = render(() => (
      <Tooltip content="focus tooltip" focusable>
        <span>Badge</span>
      </Tooltip>
    ));
    const trigger = container.querySelector("span.inline-flex")!;
    fireEvent.focusIn(trigger);
    expect(document.body.textContent).toContain("focus tooltip");
  });

  it("closes tooltip state on focusOut", () => {
    const { container } = render(() => (
      <Tooltip content="focus tooltip" focusable>
        <span>Badge</span>
      </Tooltip>
    ));
    const trigger = container.querySelector("span.inline-flex")!;
    fireEvent.focusIn(trigger);
    expect(trigger.getAttribute("data-expanded")).toBe("");
    fireEvent.focusOut(trigger);
    expect(trigger.hasAttribute("data-expanded")).toBe(false);
  });
});

describe("InfoTooltip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders (i) button with aria-label 'More information'", () => {
    render(() => <InfoTooltip content="Helpful info" />);
    const btn = screen.getByRole("button", { name: "More information" });
    expect(btn).toBeTruthy();
    expect(btn.textContent?.trim()).toBe("i");
  });

  it("button has cursor-help class", () => {
    render(() => <InfoTooltip content="Helpful info" />);
    const btn = screen.getByRole("button", { name: "More information" });
    expect(btn.classList.contains("cursor-help")).toBe(true);
  });

  it("shows tooltip content after hover (openDelay=300ms)", () => {
    render(() => <InfoTooltip content="helpful info text" />);
    const btn = screen.getByRole("button", { name: "More information" });
    fireEvent.pointerEnter(btn);
    expect(document.body.textContent).not.toContain("helpful info text");
    vi.advanceTimersByTime(300);
    expect(document.body.textContent).toContain("helpful info text");
  });
});

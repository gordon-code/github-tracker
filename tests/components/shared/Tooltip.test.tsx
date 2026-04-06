import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
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
});

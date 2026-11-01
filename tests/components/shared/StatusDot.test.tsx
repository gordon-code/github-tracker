import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import StatusDot from "../../../src/app/components/shared/StatusDot";

describe("StatusDot", () => {
  it('shows "All checks passed" label for status="success"', () => {
    const { container } = render(() => <StatusDot status="success" />);
    const wrapper = container.querySelector("[aria-label]");
    expect(wrapper?.getAttribute("aria-label")).toBe("All checks passed");
  });

  it('shows "Checks in progress" label and bg-warning for status="running"', () => {
    const { container } = render(() => <StatusDot status="running" />);
    const wrapper = container.querySelector("[aria-label]");
    expect(wrapper?.getAttribute("aria-label")).toBe("Checks in progress");
    expect(container.querySelector(".bg-warning")).not.toBeNull();
  });

  it('shows "Checks pending human action" label and bg-amber-500 for status="waiting"', () => {
    const { container } = render(() => <StatusDot status="waiting" />);
    const wrapper = container.querySelector("[aria-label]");
    expect(wrapper?.getAttribute("aria-label")).toBe("Checks pending human action");
    expect(container.querySelector(".bg-amber-500")).not.toBeNull();
  });

  it('shows "Checks pending condition" label and ringed warning style for status="pending"', () => {
    const { container } = render(() => <StatusDot status="pending" />);
    const wrapper = container.querySelector("[aria-label]");
    expect(wrapper?.getAttribute("aria-label")).toBe("Checks pending condition");
    const dot = wrapper?.querySelector("span");
    expect(dot?.className).toContain("border-warning/80");
    expect(dot?.className).toContain("bg-warning/20");
  });

  it('shows "Checks failing" label for status="failure"', () => {
    const { container } = render(() => <StatusDot status="failure" />);
    const wrapper = container.querySelector("[aria-label]");
    expect(wrapper?.getAttribute("aria-label")).toBe("Checks failing");
  });

  it('shows "Checks failing" label for status="error"', () => {
    const { container } = render(() => <StatusDot status="error" />);
    const wrapper = container.querySelector("[aria-label]");
    expect(wrapper?.getAttribute("aria-label")).toBe("Checks failing");
  });

  it('shows "No checks" label for status=null', () => {
    const { container } = render(() => <StatusDot status={null} />);
    const wrapper = container.querySelector("[aria-label]");
    expect(wrapper?.getAttribute("aria-label")).toBe("No checks");
  });

  it('shows "Checks blocked by merge conflict" label for status="conflict"', () => {
    const { container } = render(() => <StatusDot status="conflict" />);
    const wrapper = container.querySelector("[aria-label]");
    expect(wrapper?.getAttribute("aria-label")).toBe("Checks blocked by merge conflict");
  });

  it("wraps dot in a link when href is provided", () => {
    const { container } = render(() => (
      <StatusDot status="success" href="https://github.com/owner/repo/checks" />
    ));
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("https://github.com/owner/repo/checks");
    expect(link!.getAttribute("target")).toBe("_blank");
    expect(link!.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("has animate-slow-pulse class only for status=running", () => {
    const { container: runningContainer } = render(() => <StatusDot status="running" />);
    expect(runningContainer.querySelector(".animate-slow-pulse")).not.toBeNull();

    const { container: waitingContainer } = render(() => <StatusDot status="waiting" />);
    expect(waitingContainer.querySelector(".animate-slow-pulse")).toBeNull();

    const { container: pendingContainer } = render(() => <StatusDot status="pending" />);
    expect(pendingContainer.querySelector(".animate-slow-pulse")).toBeNull();

    const { container: successContainer } = render(() => <StatusDot status="success" />);
    expect(successContainer.querySelector(".animate-slow-pulse")).toBeNull();

    const { container: failureContainer } = render(() => <StatusDot status="failure" />);
    expect(failureContainer.querySelector(".animate-slow-pulse")).toBeNull();

    const { container: nullContainer } = render(() => <StatusDot status={null} />);
    expect(nullContainer.querySelector(".animate-slow-pulse")).toBeNull();
  });

});

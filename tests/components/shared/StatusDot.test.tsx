import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import StatusDot from "../../../src/app/components/shared/StatusDot";

describe("StatusDot", () => {
  it('shows "All checks passed" label for status="success"', () => {
    const { container } = render(() => <StatusDot status="success" />);
    const wrapper = container.querySelector("span");
    expect(wrapper?.getAttribute("aria-label")).toBe("All checks passed");
    expect(wrapper?.getAttribute("title")).toBe("All checks passed");
  });

  it('shows "Checks pending" label for status="pending"', () => {
    const { container } = render(() => <StatusDot status="pending" />);
    const wrapper = container.querySelector("span");
    expect(wrapper?.getAttribute("aria-label")).toBe("Checks pending");
    expect(wrapper?.getAttribute("title")).toBe("Checks pending");
  });

  it('shows "Checks failing" label for status="failure"', () => {
    const { container } = render(() => <StatusDot status="failure" />);
    const wrapper = container.querySelector("span");
    expect(wrapper?.getAttribute("aria-label")).toBe("Checks failing");
  });

  it('shows "Checks failing" label for status="error"', () => {
    const { container } = render(() => <StatusDot status="error" />);
    const wrapper = container.querySelector("span");
    expect(wrapper?.getAttribute("aria-label")).toBe("Checks failing");
  });

  it('shows "No checks" label for status=null', () => {
    const { container } = render(() => <StatusDot status={null} />);
    const wrapper = container.querySelector("span");
    expect(wrapper?.getAttribute("aria-label")).toBe("No checks");
  });

  it("has animate-ping class only for status=pending", () => {
    const { container: pendingContainer } = render(() => <StatusDot status="pending" />);
    expect(pendingContainer.querySelector(".animate-ping")).not.toBeNull();

    const { container: successContainer } = render(() => <StatusDot status="success" />);
    expect(successContainer.querySelector(".animate-ping")).toBeNull();

    const { container: failureContainer } = render(() => <StatusDot status="failure" />);
    expect(failureContainer.querySelector(".animate-ping")).toBeNull();

    const { container: nullContainer } = render(() => <StatusDot status={null} />);
    expect(nullContainer.querySelector(".animate-ping")).toBeNull();
  });

});

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

  it("uses bg-green-500 for success", () => {
    const { container } = render(() => <StatusDot status="success" />);
    expect(container.querySelector(".bg-green-500")).not.toBeNull();
  });

  it("uses bg-yellow-500 for pending", () => {
    const { container } = render(() => <StatusDot status="pending" />);
    expect(container.querySelector(".bg-yellow-500")).not.toBeNull();
  });

  it("uses bg-red-500 for failure", () => {
    const { container } = render(() => <StatusDot status="failure" />);
    expect(container.querySelector(".bg-red-500")).not.toBeNull();
  });

  it("uses bg-red-500 for error", () => {
    const { container } = render(() => <StatusDot status="error" />);
    expect(container.querySelector(".bg-red-500")).not.toBeNull();
  });

  it("uses bg-gray-300 for null", () => {
    const { container } = render(() => <StatusDot status={null} />);
    expect(container.querySelector(".bg-gray-300")).not.toBeNull();
  });
});

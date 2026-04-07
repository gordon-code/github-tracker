import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import StatusDot from "../../../src/app/components/shared/StatusDot";

describe("StatusDot", () => {
  it('shows "All checks passed" label for status="success"', () => {
    const { container } = render(() => <StatusDot status="success" />);
    const wrapper = container.querySelector("[aria-label]");
    expect(wrapper?.getAttribute("aria-label")).toBe("All checks passed");
  });

  it('shows "Checks in progress" label for status="pending"', () => {
    const { container } = render(() => <StatusDot status="pending" />);
    const wrapper = container.querySelector("[aria-label]");
    expect(wrapper?.getAttribute("aria-label")).toBe("Checks in progress");
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

  it("has animate-slow-pulse class only for status=pending", () => {
    const { container: pendingContainer } = render(() => <StatusDot status="pending" />);
    expect(pendingContainer.querySelector(".animate-slow-pulse")).not.toBeNull();

    const { container: successContainer } = render(() => <StatusDot status="success" />);
    expect(successContainer.querySelector(".animate-slow-pulse")).toBeNull();

    const { container: failureContainer } = render(() => <StatusDot status="failure" />);
    expect(failureContainer.querySelector(".animate-slow-pulse")).toBeNull();

    const { container: nullContainer } = render(() => <StatusDot status={null} />);
    expect(nullContainer.querySelector(".animate-slow-pulse")).toBeNull();
  });

});

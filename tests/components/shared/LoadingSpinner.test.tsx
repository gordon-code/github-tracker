import { describe, it, expect } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import LoadingSpinner from "../../../src/app/components/shared/LoadingSpinner";

describe("LoadingSpinner", () => {
  it('renders element with role="status"', () => {
    render(() => <LoadingSpinner />);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("has loading-spinner class on spinner element", () => {
    const { container } = render(() => <LoadingSpinner />);
    const spinner = container.querySelector(".loading");
    expect(spinner).not.toBeNull();
    expect(spinner?.className).toContain("loading-spinner");
  });

  it('uses loading-sm for size="sm"', () => {
    const { container } = render(() => <LoadingSpinner size="sm" />);
    const spinner = container.querySelector(".loading");
    expect(spinner?.className).toContain("loading-sm");
  });

  it('uses loading-md for size="md" (default)', () => {
    const { container } = render(() => <LoadingSpinner />);
    const spinner = container.querySelector(".loading");
    expect(spinner?.className).toContain("loading-md");
  });

  it('uses loading-lg for size="lg"', () => {
    const { container } = render(() => <LoadingSpinner size="lg" />);
    const spinner = container.querySelector(".loading");
    expect(spinner?.className).toContain("loading-lg");
  });

  it("shows label text when label prop provided", () => {
    render(() => <LoadingSpinner label="Loading data..." />);
    expect(screen.getByText("Loading data...")).toBeTruthy();
  });

  it("does not render label span when label omitted", () => {
    const { container } = render(() => <LoadingSpinner />);
    // The wrapper div has role="status", the only spans are the loading spinner
    const spans = container.querySelectorAll("span");
    // Only the loading spinner span should exist, no text span
    expect(Array.from(spans).some((s) => s.textContent?.trim())).toBe(false);
  });
});

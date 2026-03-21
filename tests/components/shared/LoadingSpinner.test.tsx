import { describe, it, expect } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import LoadingSpinner from "../../../src/app/components/shared/LoadingSpinner";

describe("LoadingSpinner", () => {
  it('renders element with role="status"', () => {
    render(() => <LoadingSpinner />);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("has animate-spin class on SVG", () => {
    const { container } = render(() => <LoadingSpinner />);
    const svg = container.querySelector("svg");
    expect(svg?.className).toContain("animate-spin");
  });

  it('uses h-4 w-4 for size="sm"', () => {
    const { container } = render(() => <LoadingSpinner size="sm" />);
    const svg = container.querySelector("svg");
    expect(svg?.className).toContain("h-4");
    expect(svg?.className).toContain("w-4");
  });

  it('uses h-8 w-8 for size="md" (default)', () => {
    const { container } = render(() => <LoadingSpinner />);
    const svg = container.querySelector("svg");
    expect(svg?.className).toContain("h-8");
    expect(svg?.className).toContain("w-8");
  });

  it('uses h-12 w-12 for size="lg"', () => {
    const { container } = render(() => <LoadingSpinner size="lg" />);
    const svg = container.querySelector("svg");
    expect(svg?.className).toContain("h-12");
    expect(svg?.className).toContain("w-12");
  });

  it("shows label text when label prop provided", () => {
    render(() => <LoadingSpinner label="Loading data..." />);
    expect(screen.getByText("Loading data...")).toBeTruthy();
  });

  it("does not render label element when label omitted", () => {
    const { container } = render(() => <LoadingSpinner />);
    expect(container.querySelector("span")).toBeNull();
  });
});

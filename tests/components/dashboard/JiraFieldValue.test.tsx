import { describe, it, expect } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import JiraFieldValue from "../../../src/app/components/dashboard/JiraFieldValue";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("JiraFieldValue", () => {
  it("renders '—' for null value", () => {
    render(() => <JiraFieldValue value={null} />);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("renders '—' for undefined value", () => {
    render(() => <JiraFieldValue value={undefined} />);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("renders string value directly", () => {
    render(() => <JiraFieldValue value="hello" />);
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("renders number value as string", () => {
    render(() => <JiraFieldValue value={42} />);
    expect(screen.getByText("42")).toBeTruthy();
  });

  it("renders { value: 'High' } (option field) as 'High'", () => {
    render(() => <JiraFieldValue value={{ value: "High" }} />);
    expect(screen.getByText("High")).toBeTruthy();
  });

  it("renders { displayName: 'Alice' } (user field) as 'Alice'", () => {
    render(() => <JiraFieldValue value={{ displayName: "Alice" }} />);
    expect(screen.getByText("Alice")).toBeTruthy();
  });

  it("renders string array with all items present in output", () => {
    const { container } = render(() => <JiraFieldValue value={["A", "B", "C"]} />);
    const text = container.textContent ?? "";
    expect(text).toContain("A");
    expect(text).toContain("B");
    expect(text).toContain("C");
  });

  it("renders option object array as comma-joined values", () => {
    render(() => <JiraFieldValue value={[{ value: "X" }, { value: "Y" }]} />);
    expect(screen.getByText("X")).toBeTruthy();
    expect(screen.getByText("Y")).toBeTruthy();
  });

  it("renders arbitrary nested object as JSON string fallback", () => {
    const { container } = render(() => <JiraFieldValue value={{ nested: { deep: true } }} />);
    expect(container.textContent).toContain("{");
    expect(container.textContent).toContain("nested");
  });

  it("truncates long string to 100 chars with ellipsis", () => {
    const long = "a".repeat(200);
    const { container } = render(() => <JiraFieldValue value={long} />);
    const text = container.textContent ?? "";
    expect(text.length).toBeLessThanOrEqual(102); // 100 chars + "…" + possible wrapper
    expect(text).toContain("…");
  });

  it("filters out nested arrays ([['nested']]) — renders '—' for empty result", () => {
    render(() => <JiraFieldValue value={[["nested"]]} />);
    // Nested arrays are filtered out by the depth-1 guard; result is empty → "—"
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("date-only string '2026-04-15' renders as relative time or date string (not raw ISO)", () => {
    const { container } = render(() => <JiraFieldValue value="2026-04-15" />);
    const text = container.textContent ?? "";
    expect(text).not.toBe("2026-04-15");
    expect(text).not.toContain("Invalid Date");
    expect(text.length).toBeGreaterThan(0);
  });

  it("full ISO timestamp '2026-04-15T10:00:00.000+0000' renders as relative time", () => {
    const { container } = render(() => <JiraFieldValue value="2026-04-15T10:00:00.000+0000" />);
    const text = container.textContent ?? "";
    expect(text).not.toBe("2026-04-15T10:00:00.000+0000");
    expect(text).not.toContain("Invalid Date");
    expect(text.length).toBeGreaterThan(0);
  });

  it("string matching date regex but with invalid date '2024-01-99' renders as plain text, not 'Invalid Date'", () => {
    const { container } = render(() => <JiraFieldValue value="2024-01-99-PROJ-42" />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("Invalid Date");
    // Falls through to plain string path since Date is invalid and relativeTime returns null/empty
    expect(text.length).toBeGreaterThan(0);
  });
});

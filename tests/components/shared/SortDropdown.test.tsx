import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import SortDropdown from "../../../src/app/components/shared/SortDropdown";
import type { SortOption } from "../../../src/app/components/shared/SortDropdown";

const options: SortOption[] = [
  { label: "Updated", field: "updated", type: "date" },
  { label: "Title", field: "title", type: "text" },
  { label: "Comments", field: "comments", type: "number" },
];

describe("SortDropdown", () => {
  it("renders two options per field (asc and desc)", () => {
    render(() => (
      <SortDropdown
        options={options}
        value="updated"
        direction="desc"
        onChange={vi.fn()}
      />
    ));
    const select = screen.getByRole("combobox", { name: "Sort by" });
    const opts = select.querySelectorAll("option");
    expect(opts.length).toBe(6); // 3 fields × 2 directions
  });

  it("shows current selection as selected option", () => {
    render(() => (
      <SortDropdown
        options={options}
        value="title"
        direction="asc"
        onChange={vi.fn()}
      />
    ));
    const select = screen.getByRole("combobox", { name: "Sort by" }) as HTMLSelectElement;
    expect(select.value).toBe("title:asc");
  });

  it("calls onChange with new field and direction when selecting a different option", () => {
    const onChange = vi.fn();
    render(() => (
      <SortDropdown
        options={options}
        value="updated"
        direction="desc"
        onChange={onChange}
      />
    ));
    const select = screen.getByRole("combobox", { name: "Sort by" });
    fireEvent.change(select, { target: { value: "comments:asc" } });
    expect(onChange).toHaveBeenCalledWith("comments", "asc");
  });

  it("calls onChange when selecting opposite direction for current field", () => {
    const onChange = vi.fn();
    render(() => (
      <SortDropdown
        options={options}
        value="updated"
        direction="desc"
        onChange={onChange}
      />
    ));
    const select = screen.getByRole("combobox", { name: "Sort by" });
    fireEvent.change(select, { target: { value: "updated:asc" } });
    expect(onChange).toHaveBeenCalledWith("updated", "asc");
  });

  it("applies correct styling classes", () => {
    render(() => (
      <SortDropdown
        options={options}
        value="updated"
        direction="desc"
        onChange={vi.fn()}
      />
    ));
    const select = screen.getByRole("combobox", { name: "Sort by" });
    expect(select.className).toContain("text-sm");
    expect(select.className).toContain("rounded-md");
    expect(select.className).toContain("border");
    expect(select.className).toContain("focus:ring-blue-500");
  });

  it("renders correct suffix labels for date type", () => {
    render(() => (
      <SortDropdown
        options={[{ label: "Updated", field: "updated", type: "date" }]}
        value="updated"
        direction="desc"
        onChange={vi.fn()}
      />
    ));
    const select = screen.getByRole("combobox", { name: "Sort by" });
    const opts = Array.from(select.querySelectorAll("option")).map((o) => o.textContent ?? "");
    expect(opts.some((t) => t.includes("(newest first)"))).toBe(true);
    expect(opts.some((t) => t.includes("(oldest first)"))).toBe(true);
  });

  it("renders correct suffix labels for text type", () => {
    render(() => (
      <SortDropdown
        options={[{ label: "Title", field: "title", type: "text" }]}
        value="title"
        direction="asc"
        onChange={vi.fn()}
      />
    ));
    const select = screen.getByRole("combobox", { name: "Sort by" });
    const opts = Array.from(select.querySelectorAll("option")).map((o) => o.textContent ?? "");
    expect(opts.some((t) => t.includes("(A-Z)"))).toBe(true);
    expect(opts.some((t) => t.includes("(Z-A)"))).toBe(true);
  });

  it("renders correct suffix labels for number type", () => {
    render(() => (
      <SortDropdown
        options={[{ label: "Comments", field: "comments", type: "number" }]}
        value="comments"
        direction="desc"
        onChange={vi.fn()}
      />
    ));
    const select = screen.getByRole("combobox", { name: "Sort by" });
    const opts = Array.from(select.querySelectorAll("option")).map((o) => o.textContent ?? "");
    expect(opts.some((t) => t.includes("(most)"))).toBe(true);
    expect(opts.some((t) => t.includes("(fewest)"))).toBe(true);
  });
});

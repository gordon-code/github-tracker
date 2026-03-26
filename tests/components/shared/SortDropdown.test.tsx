import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import SortDropdown from "../../../src/app/components/shared/SortDropdown";
import type { SortOption } from "../../../src/app/components/shared/SortDropdown";

const options: SortOption[] = [
  { label: "Updated", field: "updated", type: "date" },
  { label: "Title", field: "title", type: "text" },
  { label: "Comments", field: "comments", type: "number" },
];

describe("SortDropdown", () => {
  it("renders a trigger button with aria-label 'Sort by'", () => {
    render(() => (
      <SortDropdown
        options={options}
        value="updated"
        direction="desc"
        onChange={vi.fn()}
      />
    ));
    const trigger = screen.getByRole("button", { name: /Sort by/ });
    expect(trigger).toBeTruthy();
    expect(trigger.getAttribute("aria-label")).toBe("Sort by");
  });

  it("shows six options in listbox when trigger is clicked", async () => {
    const user = userEvent.setup();
    render(() => (
      <SortDropdown
        options={options}
        value="updated"
        direction="desc"
        onChange={vi.fn()}
      />
    ));
    await user.click(screen.getByRole("button", { name: /Sort by/ }));
    const listbox = screen.getByRole("listbox");
    const opts = listbox.querySelectorAll("[role='option']");
    expect(opts.length).toBe(6); // 3 fields × 2 directions
  });

  it("shows current selection label in trigger", () => {
    render(() => (
      <SortDropdown
        options={options}
        value="title"
        direction="asc"
        onChange={vi.fn()}
      />
    ));
    const trigger = screen.getByRole("button", { name: /Sort by/ });
    expect(trigger.textContent).toContain("Title (A-Z)");
  });

  it("calls onChange with new field and direction when selecting an option", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(() => (
      <SortDropdown
        options={options}
        value="updated"
        direction="desc"
        onChange={onChange}
      />
    ));
    await user.click(screen.getByRole("button", { name: /Sort by/ }));
    const opts = screen.getAllByRole("option");
    const commentsFewest = opts.find((o) => o.textContent?.includes("(fewest)"));
    expect(commentsFewest).toBeDefined();
    await user.click(commentsFewest!);
    expect(onChange).toHaveBeenCalledWith("comments", "asc");
  });

  it("calls onChange when selecting opposite direction for current field", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(() => (
      <SortDropdown
        options={options}
        value="updated"
        direction="desc"
        onChange={onChange}
      />
    ));
    await user.click(screen.getByRole("button", { name: /Sort by/ }));
    const opts = screen.getAllByRole("option");
    const oldestFirst = opts.find((o) => o.textContent?.includes("(oldest first)"));
    expect(oldestFirst).toBeDefined();
    await user.click(oldestFirst!);
    expect(onChange).toHaveBeenCalledWith("updated", "asc");
  });

  it("renders correct suffix labels for date type", async () => {
    const user = userEvent.setup();
    render(() => (
      <SortDropdown
        options={[{ label: "Updated", field: "updated", type: "date" }]}
        value="updated"
        direction="desc"
        onChange={vi.fn()}
      />
    ));
    await user.click(screen.getByRole("button", { name: /Sort by/ }));
    const opts = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(opts.some((t) => t.includes("(newest first)"))).toBe(true);
    expect(opts.some((t) => t.includes("(oldest first)"))).toBe(true);
  });

  it("renders correct suffix labels for text type", async () => {
    const user = userEvent.setup();
    render(() => (
      <SortDropdown
        options={[{ label: "Title", field: "title", type: "text" }]}
        value="title"
        direction="asc"
        onChange={vi.fn()}
      />
    ));
    await user.click(screen.getByRole("button", { name: /Sort by/ }));
    const opts = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(opts.some((t) => t.includes("(A-Z)"))).toBe(true);
    expect(opts.some((t) => t.includes("(Z-A)"))).toBe(true);
  });

  it("renders correct suffix labels for number type", async () => {
    const user = userEvent.setup();
    render(() => (
      <SortDropdown
        options={[{ label: "Comments", field: "comments", type: "number" }]}
        value="comments"
        direction="desc"
        onChange={vi.fn()}
      />
    ));
    await user.click(screen.getByRole("button", { name: /Sort by/ }));
    const opts = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(opts.some((t) => t.includes("(most)"))).toBe(true);
    expect(opts.some((t) => t.includes("(fewest)"))).toBe(true);
  });
});

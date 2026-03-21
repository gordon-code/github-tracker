import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import PaginationControls from "../../../src/app/components/shared/PaginationControls";

describe("PaginationControls", () => {
  it("renders nothing when pageCount <= 1", () => {
    const { container } = render(() => (
      <PaginationControls
        page={0}
        pageCount={1}
        totalItems={5}
        itemLabel="issue"
        onPrev={vi.fn()}
        onNext={vi.fn()}
      />
    ));
    expect(container.querySelector("div")).toBeNull();
  });

  it("renders nothing when pageCount is 0", () => {
    const { container } = render(() => (
      <PaginationControls
        page={0}
        pageCount={0}
        totalItems={0}
        itemLabel="issue"
        onPrev={vi.fn()}
        onNext={vi.fn()}
      />
    ));
    expect(container.querySelector("div")).toBeNull();
  });

  it('shows "Page X of Y" text when pageCount > 1', () => {
    render(() => (
      <PaginationControls
        page={1}
        pageCount={3}
        totalItems={10}
        itemLabel="issue"
        onPrev={vi.fn()}
        onNext={vi.fn()}
      />
    ));
    expect(screen.getByText(/Page 2 of 3/)).toBeTruthy();
  });

  it('shows correct pluralization: "1 issue" for totalItems=1', () => {
    const { container } = render(() => (
      <PaginationControls
        page={0}
        pageCount={2}
        totalItems={1}
        itemLabel="issue"
        onPrev={vi.fn()}
        onNext={vi.fn()}
      />
    ));
    const span = container.querySelector("span");
    expect(span?.textContent).toContain("1");
    expect(span?.textContent).toMatch(/\bissue\b/);
    expect(span?.textContent).not.toContain("issues");
  });

  it('shows correct pluralization: "2 issues" for totalItems=2', () => {
    const { container } = render(() => (
      <PaginationControls
        page={0}
        pageCount={2}
        totalItems={2}
        itemLabel="issue"
        onPrev={vi.fn()}
        onNext={vi.fn()}
      />
    ));
    const span = container.querySelector("span");
    expect(span?.textContent).toContain("2");
    expect(span?.textContent).toContain("issues");
  });

  it("Prev button is disabled when page === 0", () => {
    render(() => (
      <PaginationControls
        page={0}
        pageCount={3}
        totalItems={10}
        itemLabel="issue"
        onPrev={vi.fn()}
        onNext={vi.fn()}
      />
    ));
    const prevBtn = screen.getByLabelText("Previous page") as HTMLButtonElement;
    expect(prevBtn.disabled).toBe(true);
  });

  it("Next button is disabled when page >= pageCount - 1", () => {
    render(() => (
      <PaginationControls
        page={2}
        pageCount={3}
        totalItems={10}
        itemLabel="issue"
        onPrev={vi.fn()}
        onNext={vi.fn()}
      />
    ));
    const nextBtn = screen.getByLabelText("Next page") as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(true);
  });

  it("clicking Prev calls onPrev", async () => {
    const user = userEvent.setup();
    const onPrev = vi.fn();
    render(() => (
      <PaginationControls
        page={1}
        pageCount={3}
        totalItems={10}
        itemLabel="issue"
        onPrev={onPrev}
        onNext={vi.fn()}
      />
    ));
    await user.click(screen.getByLabelText("Previous page"));
    expect(onPrev).toHaveBeenCalledOnce();
  });

  it("clicking Next calls onNext", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    render(() => (
      <PaginationControls
        page={1}
        pageCount={3}
        totalItems={10}
        itemLabel="issue"
        onPrev={vi.fn()}
        onNext={onNext}
      />
    ));
    await user.click(screen.getByLabelText("Next page"));
    expect(onNext).toHaveBeenCalledOnce();
  });
});

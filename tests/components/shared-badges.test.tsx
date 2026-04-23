import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import RoleBadge from "../../src/app/components/shared/RoleBadge";
import ReviewBadge from "../../src/app/components/shared/ReviewBadge";
import SizeBadge from "../../src/app/components/shared/SizeBadge";

describe("RoleBadge", () => {
  it("renders nothing for empty roles", () => {
    const { container } = render(() => <RoleBadge roles={[]} />);
    expect(container.textContent).toBe("");
  });

  it("renders single role", () => {
    render(() => <RoleBadge roles={["author"]} />);
    screen.getByText("Author");
  });

  it("renders multiple roles", () => {
    render(() => <RoleBadge roles={["author", "reviewer"]} />);
    screen.getByText("Author");
    screen.getByText("Reviewer");
  });

  it("renders all three roles", () => {
    render(() => <RoleBadge roles={["author", "reviewer", "assignee"]} />);
    screen.getByText("Author");
    screen.getByText("Reviewer");
    screen.getByText("Assignee");
  });
});

describe("ReviewBadge", () => {
  it("renders nothing for null decision", () => {
    const { container } = render(() => <ReviewBadge decision={null} />);
    expect(container.textContent).toBe("");
  });

  it("renders 'Approved' for APPROVED", () => {
    render(() => <ReviewBadge decision="APPROVED" />);
    screen.getByText("Approved");
  });

  it("renders 'Changes' for CHANGES_REQUESTED", () => {
    render(() => <ReviewBadge decision="CHANGES_REQUESTED" />);
    screen.getByText("Changes");
  });

  it("renders 'Review needed' for REVIEW_REQUIRED", () => {
    render(() => <ReviewBadge decision="REVIEW_REQUIRED" />);
    screen.getByText("Review needed");
  });
});

describe("SizeBadge", () => {
  it("renders nothing for zero additions/deletions/files", () => {
    const { container } = render(() => (
      <SizeBadge additions={0} deletions={0} changedFiles={0} />
    ));
    expect(container.textContent).toBe("");
  });

  it("renders XS badge for small changes", () => {
    render(() => <SizeBadge additions={3} deletions={2} changedFiles={1} />);
    screen.getByText("XS");
    screen.getByText("+3");
    screen.getByText("-2");
    screen.getByText("1 file");
  });

  it("renders S badge for small-medium changes", () => {
    render(() => <SizeBadge additions={15} deletions={14} changedFiles={2} />);
    screen.getByText("S");
  });

  it("renders M badge for medium changes", () => {
    render(() => <SizeBadge additions={15} deletions={15} changedFiles={3} />);
    screen.getByText("M");
  });

  it("renders L badge for large changes", () => {
    render(() => <SizeBadge additions={200} deletions={100} changedFiles={10} />);
    screen.getByText("L");
  });

  it("renders XL badge for extra-large changes", () => {
    render(() => <SizeBadge additions={400} deletions={200} changedFiles={20} />);
    screen.getByText("XL");
  });

  it("renders XXL badge for large changes", () => {
    render(() => <SizeBadge additions={800} deletions={500} changedFiles={42} />);
    screen.getByText("XXL");
    screen.getByText("+800");
    screen.getByText("-500");
    screen.getByText("42 files");
  });

  it("uses pre-computed category when provided", () => {
    render(() => <SizeBadge additions={1} deletions={1} changedFiles={1} category="L" />);
    screen.getByText("L");
  });

  it("renders when only changedFiles > 0", () => {
    render(() => <SizeBadge additions={0} deletions={0} changedFiles={1} />);
    screen.getByText("XS");
  });

  describe("tooltips", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("shows tooltip with size description on hover", () => {
      const { container } = render(() => (
        <SizeBadge additions={3} deletions={2} changedFiles={1} />
      ));
      const trigger = container.querySelector("span.inline-flex");
      expect(trigger).not.toBeNull();
      fireEvent.pointerEnter(trigger!);
      vi.advanceTimersByTime(300);
      expect(document.body.textContent).toContain("XS: <10 lines changed");
      fireEvent.pointerLeave(trigger!);
      vi.advanceTimersByTime(500);
    });

    it("shows tooltip with S size description on hover", () => {
      const { container } = render(() => (
        <SizeBadge additions={10} deletions={5} changedFiles={2} />
      ));
      const trigger = container.querySelector("span.inline-flex");
      expect(trigger).not.toBeNull();
      fireEvent.pointerEnter(trigger!);
      vi.advanceTimersByTime(300);
      expect(document.body.textContent).toContain("S: 10–29 lines changed");
      fireEvent.pointerLeave(trigger!);
      vi.advanceTimersByTime(500);
    });

    it("shows tooltip with XXL size description on hover", () => {
      const { container } = render(() => (
        <SizeBadge additions={800} deletions={500} changedFiles={42} />
      ));
      const trigger = container.querySelector("span.inline-flex");
      expect(trigger).not.toBeNull();
      fireEvent.pointerEnter(trigger!);
      vi.advanceTimersByTime(300);
      expect(document.body.textContent).toContain("XXL: 1000+ lines changed");
      fireEvent.pointerLeave(trigger!);
      vi.advanceTimersByTime(500);
    });
  });
});

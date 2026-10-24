import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import RoleBadge from "../../src/app/components/shared/RoleBadge";
import ReviewBadge from "../../src/app/components/shared/ReviewBadge";
import SizeBadge from "../../src/app/components/shared/SizeBadge";
import AutoMergeBadge from "../../src/app/components/shared/AutoMergeBadge";
import DraftBadge from "../../src/app/components/shared/DraftBadge";

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

describe("AutoMergeBadge", () => {
  it("renders nothing when method is null or undefined", () => {
    const { container: c1 } = render(() => <AutoMergeBadge method={null} />);
    expect(c1.textContent).toBe("");
    const { container: c2 } = render(() => <AutoMergeBadge />);
    expect(c2.textContent).toBe("");
  });

  it("renders 'auto' with badge-sm by default for MERGE, SQUASH, and REBASE", () => {
    const { unmount: u1 } = render(() => <AutoMergeBadge method="MERGE" />);
    const b1 = screen.getByTestId("auto-merge-badge");
    expect(b1.textContent).toBe("auto");
    expect(b1.className).toContain("badge-sm");
    expect(b1.getAttribute("aria-label")).toBe("Auto-merge enabled (merge)");
    u1();

    const { unmount: u2 } = render(() => <AutoMergeBadge method="SQUASH" />);
    const b2 = screen.getByTestId("auto-merge-badge");
    expect(b2.getAttribute("aria-label")).toBe("Auto-merge enabled (squash)");
    u2();

    const { unmount: u3 } = render(() => <AutoMergeBadge method="REBASE" />);
    const b3 = screen.getByTestId("auto-merge-badge");
    expect(b3.getAttribute("aria-label")).toBe("Auto-merge enabled (rebase)");
    u3();
  });

  it("renders badge-xs when compact={true}", () => {
    render(() => <AutoMergeBadge method="SQUASH" compact />);
    const badge = screen.getByTestId("auto-merge-badge");
    expect(badge.className).toContain("badge-xs");
    expect(badge.className).not.toContain("badge-sm");
  });

  it("shows tooltip with merge method on hover", () => {
    vi.useFakeTimers();
    const { container, unmount } = render(() => <AutoMergeBadge method="SQUASH" />);
    const trigger = container.querySelector("span.inline-flex");
    expect(trigger).not.toBeNull();
    fireEvent.pointerEnter(trigger!);
    vi.advanceTimersByTime(300);
    expect(document.body.textContent).toContain("Auto-merge enabled (squash)");
    fireEvent.pointerLeave(trigger!);
    vi.advanceTimersByTime(500);
    unmount();
    vi.useRealTimers();
  });
});

describe("DraftBadge", () => {
  it("renders nothing when draft={false}", () => {
    const { container } = render(() => <DraftBadge draft={false} onMarkReady={vi.fn()} />);
    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("draft-badge")).toBeNull();
  });

  it("renders read-only <span> ('Draft' in comfortable, 'D' in compact) when onMarkReady is undefined", () => {
    const { unmount } = render(() => <DraftBadge draft={true} />);
    const comfortable = screen.getByTestId("draft-badge");
    expect(comfortable.tagName.toLowerCase()).toBe("span");
    expect(comfortable.textContent).toBe("Draft");
    expect(comfortable.className).toContain("badge-sm");
    unmount();

    render(() => <DraftBadge draft={true} compact />);
    const compact = screen.getByTestId("draft-badge");
    expect(compact.tagName.toLowerCase()).toBe("span");
    expect(compact.textContent).toBe("D");
    expect(compact.className).toContain("badge-xs");
  });

  it("renders <button> when onMarkReady is provided; first click shows 'Ready?' without calling onMarkReady; second click within 4s calls onMarkReady once and resets", () => {
    const onMarkReady = vi.fn();
    const { unmount } = render(() => (
      <DraftBadge draft={true} prNumber={42} prTitle="WIP feature" onMarkReady={onMarkReady} />
    ));

    const btn = screen.getByTestId("draft-badge") as HTMLButtonElement;
    expect(btn.tagName.toLowerCase()).toBe("button");
    expect(btn.textContent).toBe("Draft");
    expect(btn.getAttribute("aria-label")).toBe("Mark #42 WIP feature ready for review");

    fireEvent.click(btn);
    expect(onMarkReady).not.toHaveBeenCalled();
    expect(btn.textContent).toBe("Ready?");
    expect(btn.getAttribute("aria-label")).toBe("Confirm mark #42 WIP feature ready for review");

    fireEvent.click(btn);
    expect(onMarkReady).toHaveBeenCalledOnce();
    expect(btn.textContent).toBe("Draft");
    expect(btn.getAttribute("aria-label")).toBe("Mark #42 WIP feature ready for review");
    unmount();

    // Compact mode: starts as "D", expands to "Ready?" on first click, resets to "D" on second click
    const onMarkReadyCompact = vi.fn();
    render(() => <DraftBadge draft={true} compact prNumber={7} onMarkReady={onMarkReadyCompact} />);
    const compactBtn = screen.getByTestId("draft-badge") as HTMLButtonElement;
    expect(compactBtn.textContent).toBe("D");
    expect(compactBtn.className).toContain("badge-xs");

    fireEvent.click(compactBtn);
    expect(compactBtn.textContent).toBe("Ready?");
    expect(onMarkReadyCompact).not.toHaveBeenCalled();

    fireEvent.click(compactBtn);
    expect(onMarkReadyCompact).toHaveBeenCalledOnce();
    expect(compactBtn.textContent).toBe("D");
  });

  it("auto-resets 'Ready?' back to 'Draft' after 4,000ms timer without calling onMarkReady", () => {
    vi.useFakeTimers();
    const onMarkReady = vi.fn();
    const { unmount } = render(() => (
      <DraftBadge draft={true} prNumber={42} prTitle="WIP feature" onMarkReady={onMarkReady} />
    ));

    const btn = screen.getByTestId("draft-badge");
    fireEvent.click(btn);
    expect(btn.textContent).toBe("Ready?");

    vi.advanceTimersByTime(4000);
    expect(btn.textContent).toBe("Draft");
    expect(btn.getAttribute("aria-label")).toBe("Mark #42 WIP feature ready for review");
    expect(onMarkReady).not.toHaveBeenCalled();

    unmount();
    vi.useRealTimers();
  });

  it("resets 'Ready?' back to 'Draft' on Escape keydown and on blur", () => {
    const onMarkReady = vi.fn();
    render(() => (
      <DraftBadge draft={true} prNumber={42} prTitle="WIP feature" onMarkReady={onMarkReady} />
    ));

    const btn = screen.getByTestId("draft-badge");
    fireEvent.click(btn);
    expect(btn.textContent).toBe("Ready?");

    fireEvent.keyDown(btn, { key: "Escape" });
    expect(btn.textContent).toBe("Draft");

    fireEvent.click(btn);
    expect(btn.textContent).toBe("Ready?");
    fireEvent.blur(btn);
    expect(btn.textContent).toBe("Draft");
    expect(onMarkReady).not.toHaveBeenCalled();
  });

  it("resets 'Ready?' when onMarkReady or isMarkingReady changes, and does NOT disarm when isMarkingReady re-evaluates to the same boolean value", () => {
    const onMarkReadyA = vi.fn();
    const onMarkReadyB = vi.fn();
    const [markReadyFn, setMarkReadyFn] = createSignal<() => void>(onMarkReadyA);
    const [markingSet, setMarkingSet] = createSignal<ReadonlySet<number>>(new Set<number>());

    render(() => (
      <DraftBadge
        draft={true}
        prNumber={42}
        prTitle="WIP feature"
        onMarkReady={markReadyFn()}
        isMarkingReady={markingSet().has(42)}
      />
    ));

    const btn = screen.getByTestId("draft-badge");
    fireEvent.click(btn);
    expect(btn.textContent).toBe("Ready?");

    // Another PR (#99) starts and finishes marking ready — #42's isMarkingReady stays false, so "Ready?" stays armed
    setMarkingSet(new Set([99]));
    expect(btn.textContent).toBe("Ready?");
    setMarkingSet(new Set<number>());
    expect(btn.textContent).toBe("Ready?");

    // Changing onMarkReady reference disarms confirmation
    setMarkReadyFn(() => onMarkReadyB);
    expect(btn.textContent).toBe("Draft");

    // Re-arm and verify changing isMarkingReady for #42 disarms confirmation
    fireEvent.click(btn);
    expect(btn.textContent).toBe("Ready?");
    setMarkingSet(new Set([42]));
    setMarkingSet(new Set<number>());
    expect(btn.textContent).toBe("Draft");
    expect(onMarkReadyA).not.toHaveBeenCalled();
    expect(onMarkReadyB).not.toHaveBeenCalled();
  });

  it("renders spinner and disables button when isMarkingReady={true}", () => {
    const onMarkReady = vi.fn();
    render(() => (
      <DraftBadge
        draft={true}
        prNumber={42}
        prTitle="WIP feature"
        onMarkReady={onMarkReady}
        isMarkingReady={true}
      />
    ));

    const btn = screen.getByTestId("draft-badge") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-label")).toBe("Marking #42 WIP feature ready for review");
    expect(btn.querySelector(".loading-spinner")).not.toBeNull();

    fireEvent.click(btn);
    expect(onMarkReady).not.toHaveBeenCalled();
  });
});

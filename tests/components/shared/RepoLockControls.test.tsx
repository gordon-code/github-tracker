import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import RepoLockControls from "../../../src/app/components/shared/RepoLockControls";
import { resetViewState, viewState, lockRepo } from "../../../src/app/stores/view";

beforeEach(() => {
  resetViewState();
});

describe("RepoLockControls", () => {
  it("renders unlock (pin) icon when repo is not locked", () => {
    render(() => (
      <RepoLockControls repoFullName="owner/repo" />
    ));
    expect(screen.getByLabelText("Pin owner/repo to top of list")).toBeTruthy();
  });

  it("renders lock icon + chevrons when repo IS locked", () => {
    lockRepo("owner/repo");
    render(() => (
      <RepoLockControls repoFullName="owner/repo" />
    ));
    expect(screen.getByLabelText("Unpin owner/repo")).toBeTruthy();
    expect(screen.getByLabelText("Move owner/repo up")).toBeTruthy();
    expect(screen.getByLabelText("Move owner/repo down")).toBeTruthy();
  });

  it("click pin icon → locks the repo", () => {
    render(() => (
      <RepoLockControls repoFullName="owner/repo" />
    ));
    fireEvent.click(screen.getByLabelText("Pin owner/repo to top of list"));
    expect(viewState.lockedRepos).toContain("owner/repo");
  });

  it("click lock icon → unlocks the repo", () => {
    lockRepo("owner/repo");
    render(() => (
      <RepoLockControls repoFullName="owner/repo" />
    ));
    fireEvent.click(screen.getByLabelText("Unpin owner/repo"));
    expect(viewState.lockedRepos).not.toContain("owner/repo");
  });

  it("up button moves repo up in order", () => {
    lockRepo("owner/a");
    lockRepo("owner/b");
    render(() => (
      <RepoLockControls repoFullName="owner/b" />
    ));
    fireEvent.click(screen.getByLabelText("Move owner/b up"));
    expect(viewState.lockedRepos[0]).toBe("owner/b");
    expect(viewState.lockedRepos[1]).toBe("owner/a");
  });

  it("down button moves repo down in order", () => {
    lockRepo("owner/a");
    lockRepo("owner/b");
    render(() => (
      <RepoLockControls repoFullName="owner/a" />
    ));
    fireEvent.click(screen.getByLabelText("Move owner/a down"));
    expect(viewState.lockedRepos[0]).toBe("owner/b");
    expect(viewState.lockedRepos[1]).toBe("owner/a");
  });

  it("up button is disabled when repo is first in locked list", () => {
    lockRepo("owner/repo");
    render(() => (
      <RepoLockControls repoFullName="owner/repo" />
    ));
    const upBtn = screen.getByLabelText("Move owner/repo up") as HTMLButtonElement;
    expect(upBtn.disabled).toBe(true);
  });

  it("down button is disabled when repo is last in locked list", () => {
    lockRepo("owner/repo");
    render(() => (
      <RepoLockControls repoFullName="owner/repo" />
    ));
    const downBtn = screen.getByLabelText("Move owner/repo down") as HTMLButtonElement;
    expect(downBtn.disabled).toBe(true);
  });

  it("stopPropagation — parent click NOT triggered on locked button click", () => {
    lockRepo("owner/repo");
    const parentClick = vi.fn();
    render(() => (
      <div onClick={parentClick}>
        <RepoLockControls repoFullName="owner/repo" />
      </div>
    ));
    fireEvent.click(screen.getByLabelText("Unpin owner/repo"));
    expect(parentClick).not.toHaveBeenCalled();
  });

  it("stopPropagation — parent click NOT triggered on pin button click", () => {
    const parentClick = vi.fn();
    render(() => (
      <div onClick={parentClick}>
        <RepoLockControls repoFullName="owner/repo" />
      </div>
    ));
    fireEvent.click(screen.getByLabelText("Pin owner/repo to top of list"));
    expect(parentClick).not.toHaveBeenCalled();
  });
});

describe("RepoLockControls — scroll preservation", () => {
  beforeEach(() => {
    resetViewState();
    document.documentElement.scrollTop = 500;
    vi.spyOn(window, "scrollTo");
    // withFlipAnimation falls back to withScrollLock when reduced motion is preferred;
    // happy-dom has no layout engine so FLIP deltas are always 0
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.scrollTop = 0;
  });

  it("preserves scroll position when locking a repo", () => {
    render(() => (
      <RepoLockControls repoFullName="owner/repo" />
    ));
    fireEvent.click(screen.getByLabelText("Pin owner/repo to top of list"));
    expect(window.scrollTo).toHaveBeenCalledWith(0, 500);
  });

  it("preserves scroll position when unlocking a repo", () => {
    lockRepo("owner/repo");
    render(() => (
      <RepoLockControls repoFullName="owner/repo" />
    ));
    fireEvent.click(screen.getByLabelText("Unpin owner/repo"));
    expect(window.scrollTo).toHaveBeenCalledWith(0, 500);
  });

  it("preserves scroll position when moving repo up", () => {
    lockRepo("owner/a");
    lockRepo("owner/b");
    render(() => (
      <RepoLockControls repoFullName="owner/b" />
    ));
    fireEvent.click(screen.getByLabelText("Move owner/b up"));
    expect(window.scrollTo).toHaveBeenCalledWith(0, 500);
  });

  it("preserves scroll position when moving repo down", () => {
    lockRepo("owner/a");
    lockRepo("owner/b");
    render(() => (
      <RepoLockControls repoFullName="owner/a" />
    ));
    fireEvent.click(screen.getByLabelText("Move owner/a down"));
    expect(window.scrollTo).toHaveBeenCalledWith(0, 500);
  });
});

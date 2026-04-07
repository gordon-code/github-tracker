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
      <RepoLockControls tab="issues" repoFullName="owner/repo" />
    ));
    expect(screen.getByLabelText("Pin owner/repo to top of list")).toBeTruthy();
  });

  it("renders lock icon + chevrons when repo IS locked", () => {
    lockRepo("issues", "owner/repo");
    render(() => (
      <RepoLockControls tab="issues" repoFullName="owner/repo" />
    ));
    expect(screen.getByLabelText("Unpin owner/repo")).toBeTruthy();
    expect(screen.getByLabelText("Move owner/repo up")).toBeTruthy();
    expect(screen.getByLabelText("Move owner/repo down")).toBeTruthy();
  });

  it("click pin icon → locks the repo", () => {
    render(() => (
      <RepoLockControls tab="issues" repoFullName="owner/repo" />
    ));
    fireEvent.click(screen.getByLabelText("Pin owner/repo to top of list"));
    expect(viewState.lockedRepos.issues).toContain("owner/repo");
  });

  it("click lock icon → unlocks the repo", () => {
    lockRepo("issues", "owner/repo");
    render(() => (
      <RepoLockControls tab="issues" repoFullName="owner/repo" />
    ));
    fireEvent.click(screen.getByLabelText("Unpin owner/repo"));
    expect(viewState.lockedRepos.issues).not.toContain("owner/repo");
  });

  it("up button moves repo up in order", () => {
    lockRepo("issues", "owner/a");
    lockRepo("issues", "owner/b");
    render(() => (
      <RepoLockControls tab="issues" repoFullName="owner/b" />
    ));
    fireEvent.click(screen.getByLabelText("Move owner/b up"));
    expect(viewState.lockedRepos.issues[0]).toBe("owner/b");
    expect(viewState.lockedRepos.issues[1]).toBe("owner/a");
  });

  it("down button moves repo down in order", () => {
    lockRepo("issues", "owner/a");
    lockRepo("issues", "owner/b");
    render(() => (
      <RepoLockControls tab="issues" repoFullName="owner/a" />
    ));
    fireEvent.click(screen.getByLabelText("Move owner/a down"));
    expect(viewState.lockedRepos.issues[0]).toBe("owner/b");
    expect(viewState.lockedRepos.issues[1]).toBe("owner/a");
  });

  it("up button is disabled when repo is first in locked list", () => {
    lockRepo("issues", "owner/repo");
    render(() => (
      <RepoLockControls tab="issues" repoFullName="owner/repo" />
    ));
    const upBtn = screen.getByLabelText("Move owner/repo up") as HTMLButtonElement;
    expect(upBtn.disabled).toBe(true);
  });

  it("down button is disabled when repo is last in locked list", () => {
    lockRepo("issues", "owner/repo");
    render(() => (
      <RepoLockControls tab="issues" repoFullName="owner/repo" />
    ));
    const downBtn = screen.getByLabelText("Move owner/repo down") as HTMLButtonElement;
    expect(downBtn.disabled).toBe(true);
  });

  it("stopPropagation — parent click NOT triggered on locked button click", () => {
    lockRepo("issues", "owner/repo");
    const parentClick = vi.fn();
    render(() => (
      <div onClick={parentClick}>
        <RepoLockControls tab="issues" repoFullName="owner/repo" />
      </div>
    ));
    fireEvent.click(screen.getByLabelText("Unpin owner/repo"));
    expect(parentClick).not.toHaveBeenCalled();
  });

  it("stopPropagation — parent click NOT triggered on pin button click", () => {
    const parentClick = vi.fn();
    render(() => (
      <div onClick={parentClick}>
        <RepoLockControls tab="issues" repoFullName="owner/repo" />
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.scrollTop = 0;
  });

  it("preserves scroll position when locking a repo", () => {
    render(() => (
      <RepoLockControls tab="issues" repoFullName="owner/repo" />
    ));
    fireEvent.click(screen.getByLabelText("Pin owner/repo to top of list"));
    expect(window.scrollTo).toHaveBeenCalledWith(0, 500);
  });

  it("preserves scroll position when unlocking a repo", () => {
    lockRepo("issues", "owner/repo");
    render(() => (
      <RepoLockControls tab="issues" repoFullName="owner/repo" />
    ));
    fireEvent.click(screen.getByLabelText("Unpin owner/repo"));
    expect(window.scrollTo).toHaveBeenCalledWith(0, 500);
  });

  it("preserves scroll position when moving repo up", () => {
    lockRepo("issues", "owner/a");
    lockRepo("issues", "owner/b");
    render(() => (
      <RepoLockControls tab="issues" repoFullName="owner/b" />
    ));
    fireEvent.click(screen.getByLabelText("Move owner/b up"));
    expect(window.scrollTo).toHaveBeenCalledWith(0, 500);
  });

  it("preserves scroll position when moving repo down", () => {
    lockRepo("issues", "owner/a");
    lockRepo("issues", "owner/b");
    render(() => (
      <RepoLockControls tab="issues" repoFullName="owner/a" />
    ));
    fireEvent.click(screen.getByLabelText("Move owner/a down"));
    expect(window.scrollTo).toHaveBeenCalledWith(0, 500);
  });
});

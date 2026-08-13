import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import DependencyExclusionModal from "../../../src/app/components/settings/DependencyExclusionModal";
import type { RepoRef } from "../../../src/app/services/api";

const availableOrgs = ["orgA", "orgB"];
const availableRepos: RepoRef[] = [
  { owner: "orgA", name: "repoA1", fullName: "orgA/repoA1" },
  { owner: "orgA", name: "repoA2", fullName: "orgA/repoA2" },
  { owner: "orgB", name: "repoB1", fullName: "orgB/repoB1" },
];

function findCheckboxByLabelText(text: string): HTMLInputElement {
  const checkbox = screen
    .getAllByRole("checkbox")
    .find((cb) => cb.closest("label")?.textContent?.includes(text));
  if (!checkbox) throw new Error(`No checkbox found for label text "${text}"`);
  return checkbox as HTMLInputElement;
}

function renderModal(overrides: Partial<Parameters<typeof DependencyExclusionModal>[0]> = {}) {
  const onClose = vi.fn();
  const onSave = vi.fn();
  render(() => (
    <DependencyExclusionModal
      open={true}
      onClose={onClose}
      availableOrgs={availableOrgs}
      availableRepos={availableRepos}
      excludedOrgs={[]}
      excludedRepos={[]}
      onSave={onSave}
      {...overrides}
    />
  ));
  return { onClose, onSave };
}

describe("DependencyExclusionModal — open/close", () => {
  it("renders dialog when open is true", () => {
    renderModal();
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("does not render dialog content when open is false", () => {
    renderModal({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("calls onClose when Cancel button is clicked, without calling onSave", () => {
    const { onClose, onSave } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("calls onClose when the X button is clicked", () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("DependencyExclusionModal — pre-checked state", () => {
  it("pre-checks org/repo checkboxes matching the excludedOrgs/excludedRepos props", () => {
    renderModal({
      excludedOrgs: ["orgB"],
      excludedRepos: [{ owner: "orgA", name: "repoA2", fullName: "orgA/repoA2" }],
    });

    expect(findCheckboxByLabelText("orgA").checked).toBe(false);
    expect(findCheckboxByLabelText("orgB").checked).toBe(true);
    expect(findCheckboxByLabelText("repoA1").checked).toBe(false);
    expect(findCheckboxByLabelText("repoA2").checked).toBe(true);
    // repoB1 is covered by the orgB exclusion (checked+disabled via the OR-logic)
    expect(findCheckboxByLabelText("repoB1").checked).toBe(true);
    expect(findCheckboxByLabelText("repoB1").disabled).toBe(true);
  });
});

describe("DependencyExclusionModal — toggling", () => {
  it("checking an org excludes all of that org's nested repos", () => {
    renderModal();
    fireEvent.click(findCheckboxByLabelText("orgA"));

    expect(findCheckboxByLabelText("repoA1").checked).toBe(true);
    expect(findCheckboxByLabelText("repoA1").disabled).toBe(true);
    expect(findCheckboxByLabelText("repoA2").checked).toBe(true);
    expect(findCheckboxByLabelText("repoA2").disabled).toBe(true);
    expect(findCheckboxByLabelText("repoB1").checked).toBe(false);
  });

  it("deselecting an org un-checks and re-enables all of that org's nested repos", () => {
    renderModal();
    const orgA = findCheckboxByLabelText("orgA");
    fireEvent.click(orgA); // select
    fireEvent.click(orgA); // deselect

    expect(findCheckboxByLabelText("repoA1").checked).toBe(false);
    expect(findCheckboxByLabelText("repoA1").disabled).toBe(false);
    expect(findCheckboxByLabelText("repoA2").checked).toBe(false);
    expect(findCheckboxByLabelText("repoA2").disabled).toBe(false);
  });

  it("clicking a repo checkbox directly (org not excluded) toggles only that repo", () => {
    renderModal();
    fireEvent.click(findCheckboxByLabelText("repoA1"));

    expect(findCheckboxByLabelText("repoA1").checked).toBe(true);
    expect(findCheckboxByLabelText("repoA2").checked).toBe(false);
    expect(findCheckboxByLabelText("orgA").checked).toBe(false);
  });
});

describe("DependencyExclusionModal — save", () => {
  it("calls onSave with the current excluded orgs and repos, then calls onClose", () => {
    const { onClose, onSave } = renderModal();

    fireEvent.click(findCheckboxByLabelText("orgB"));
    fireEvent.click(findCheckboxByLabelText("repoA1"));

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const [orgs, repos] = onSave.mock.calls[0] as [string[], RepoRef[]];
    expect(orgs).toEqual(["orgB"]);
    expect(repos).toEqual([{ owner: "orgA", name: "repoA1", fullName: "orgA/repoA1" }]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("filters excluded repos against availableRepos on save (unfiltered orgs)", () => {
    const { onSave } = renderModal();

    fireEvent.click(findCheckboxByLabelText("repoA1"));
    fireEvent.click(findCheckboxByLabelText("repoB1"));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    const [, repos] = onSave.mock.calls[0] as [string[], RepoRef[]];
    expect(repos).toEqual([
      { owner: "orgA", name: "repoA1", fullName: "orgA/repoA1" },
      { owner: "orgB", name: "repoB1", fullName: "orgB/repoB1" },
    ]);
  });
});

describe("DependencyExclusionModal — reopening with different props", () => {
  it("resets local checkbox state to match new props when reopened", () => {
    type Props = Parameters<typeof DependencyExclusionModal>[0];
    const [modalProps, setModalProps] = createSignal<Props>({
      open: true,
      onClose: vi.fn(),
      availableOrgs,
      availableRepos,
      excludedOrgs: ["orgA"],
      excludedRepos: [],
      onSave: vi.fn(),
    });

    render(() => <DependencyExclusionModal {...modalProps()} />);

    expect(findCheckboxByLabelText("orgA").checked).toBe(true);
    expect(findCheckboxByLabelText("orgB").checked).toBe(false);

    // Close, then reopen with different exclusions
    setModalProps((prev) => ({ ...prev, open: false }));
    setModalProps((prev) => ({
      ...prev,
      open: true,
      excludedOrgs: ["orgB"],
      excludedRepos: [{ owner: "orgA", name: "repoA1", fullName: "orgA/repoA1" }],
    }));

    expect(findCheckboxByLabelText("orgA").checked).toBe(false);
    expect(findCheckboxByLabelText("orgB").checked).toBe(true);
    expect(findCheckboxByLabelText("repoA1").checked).toBe(true);
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import OrgRepoCheckboxTree from "../../../src/app/components/shared/OrgRepoCheckboxTree";
import { findCheckboxByLabelText } from "../../helpers/index";

const availableOrgs = ["orgA", "orgB"];
const availableRepos = [
  { owner: "orgA", name: "repoA1", fullName: "orgA/repoA1" },
  { owner: "orgA", name: "repoA2", fullName: "orgA/repoA2" },
  { owner: "orgB", name: "repoB1", fullName: "orgB/repoB1" },
];

describe("OrgRepoCheckboxTree — rendering", () => {
  it("renders one checkbox per org and one nested checkbox per repo", () => {
    render(() => (
      <OrgRepoCheckboxTree
        availableOrgs={availableOrgs}
        availableRepos={availableRepos}
        checkedOrgs={new Set()}
        checkedRepos={new Set()}
        onToggleOrg={vi.fn()}
        onToggleRepo={vi.fn()}
      />
    ));

    expect(screen.getAllByRole("checkbox")).toHaveLength(5); // 2 orgs + 3 repos
    expect(screen.getByText("orgA")).toBeDefined();
    expect(screen.getByText("orgB")).toBeDefined();
    expect(screen.getByText("repoA1")).toBeDefined();
    expect(screen.getByText("repoA2")).toBeDefined();
    expect(screen.getByText("repoB1")).toBeDefined();
  });

  it("pre-checks org checkboxes matching checkedOrgs prop", () => {
    render(() => (
      <OrgRepoCheckboxTree
        availableOrgs={availableOrgs}
        availableRepos={availableRepos}
        checkedOrgs={new Set(["orgB"])}
        checkedRepos={new Set()}
        onToggleOrg={vi.fn()}
        onToggleRepo={vi.fn()}
      />
    ));

    expect(findCheckboxByLabelText("orgA").checked).toBe(false);
    expect(findCheckboxByLabelText("orgB").checked).toBe(true);
  });

  it("pre-checks repo checkboxes matching checkedRepos prop", () => {
    render(() => (
      <OrgRepoCheckboxTree
        availableOrgs={availableOrgs}
        availableRepos={availableRepos}
        checkedOrgs={new Set()}
        checkedRepos={new Set(["orgA/repoA2"])}
        onToggleOrg={vi.fn()}
        onToggleRepo={vi.fn()}
      />
    ));

    expect(findCheckboxByLabelText("repoA1").checked).toBe(false);
    expect(findCheckboxByLabelText("repoA2").checked).toBe(true);
    expect(findCheckboxByLabelText("repoB1").checked).toBe(false);
  });

  it("checking an org checks and disables all of that org's nested repo checkboxes", () => {
    render(() => (
      <OrgRepoCheckboxTree
        availableOrgs={availableOrgs}
        availableRepos={availableRepos}
        checkedOrgs={new Set(["orgA"])}
        checkedRepos={new Set()}
        onToggleOrg={vi.fn()}
        onToggleRepo={vi.fn()}
      />
    ));

    const repoA1 = findCheckboxByLabelText("repoA1");
    const repoA2 = findCheckboxByLabelText("repoA2");
    const repoB1 = findCheckboxByLabelText("repoB1");

    expect(repoA1.checked).toBe(true);
    expect(repoA1.disabled).toBe(true);
    expect(repoA2.checked).toBe(true);
    expect(repoA2.disabled).toBe(true);
    expect(repoB1.checked).toBe(false);
    expect(repoB1.disabled).toBe(false);
  });

  it("renders emptyMessage when availableOrgs is empty", () => {
    render(() => (
      <OrgRepoCheckboxTree
        availableOrgs={[]}
        availableRepos={[]}
        checkedOrgs={new Set()}
        checkedRepos={new Set()}
        onToggleOrg={vi.fn()}
        onToggleRepo={vi.fn()}
        emptyMessage="No repos tracked yet."
      />
    ));

    expect(screen.getByText("No repos tracked yet.")).toBeDefined();
  });

  it("renders default 'No orgs available.' message when emptyMessage is omitted", () => {
    render(() => (
      <OrgRepoCheckboxTree
        availableOrgs={[]}
        availableRepos={[]}
        checkedOrgs={new Set()}
        checkedRepos={new Set()}
        onToggleOrg={vi.fn()}
        onToggleRepo={vi.fn()}
      />
    ));

    expect(screen.getByText("No orgs available.")).toBeDefined();
  });
});

describe("OrgRepoCheckboxTree — callbacks (pure function of props)", () => {
  it("calls onToggleOrg with the org's name when its checkbox is clicked", () => {
    const onToggleOrg = vi.fn();
    render(() => (
      <OrgRepoCheckboxTree
        availableOrgs={availableOrgs}
        availableRepos={availableRepos}
        checkedOrgs={new Set()}
        checkedRepos={new Set()}
        onToggleOrg={onToggleOrg}
        onToggleRepo={vi.fn()}
      />
    ));

    fireEvent.click(findCheckboxByLabelText("orgA"));
    expect(onToggleOrg).toHaveBeenCalledTimes(1);
    expect(onToggleOrg).toHaveBeenCalledWith("orgA");
  });

  it("calls onToggleRepo with the repo's fullName when its checkbox is clicked", () => {
    const onToggleRepo = vi.fn();
    render(() => (
      <OrgRepoCheckboxTree
        availableOrgs={availableOrgs}
        availableRepos={availableRepos}
        checkedOrgs={new Set()}
        checkedRepos={new Set()}
        onToggleOrg={vi.fn()}
        onToggleRepo={onToggleRepo}
      />
    ));

    fireEvent.click(findCheckboxByLabelText("repoB1"));
    expect(onToggleRepo).toHaveBeenCalledTimes(1);
    expect(onToggleRepo).toHaveBeenCalledWith("orgB/repoB1");
  });

  it("reports every click identically regardless of click history — the component owns no toggle state", () => {
    // If the component tracked its own checked/toggle state internally, repeated
    // clicks might mutate that state and change what gets reported. Since it's a
    // pure function of props + callbacks, every click on the same org must invoke
    // onToggleOrg identically.
    const onToggleOrg = vi.fn();
    render(() => (
      <OrgRepoCheckboxTree
        availableOrgs={availableOrgs}
        availableRepos={availableRepos}
        checkedOrgs={new Set()}
        checkedRepos={new Set()}
        onToggleOrg={onToggleOrg}
        onToggleRepo={vi.fn()}
      />
    ));

    const orgA = findCheckboxByLabelText("orgA");
    fireEvent.click(orgA);
    fireEvent.click(orgA);
    expect(onToggleOrg).toHaveBeenCalledTimes(2);
    expect(onToggleOrg).toHaveBeenNthCalledWith(1, "orgA");
    expect(onToggleOrg).toHaveBeenNthCalledWith(2, "orgA");
  });
});

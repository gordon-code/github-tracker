import { describe, it, expect } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createOrgRepoSelection } from "../../src/app/lib/orgRepoSelection";
import type { RepoRef } from "../../src/app/services/api";

const availableRepos: RepoRef[] = [
  { owner: "orgA", name: "repoA1", fullName: "orgA/repoA1" },
  { owner: "orgA", name: "repoA2", fullName: "orgA/repoA2" },
  { owner: "orgB", name: "repoB1", fullName: "orgB/repoB1" },
];

describe("createOrgRepoSelection", () => {
  it("initializes selectedOrgs/selectedRepos from the initial accessors", () => {
    createRoot((dispose) => {
      const sel = createOrgRepoSelection({
        getOpen: () => true,
        getAvailableRepos: () => availableRepos,
        getInitialOrgs: () => ["orgA"],
        getInitialRepos: () => ["orgB/repoB1"],
      });
      expect(sel.selectedOrgs()).toEqual(new Set(["orgA"]));
      expect(sel.selectedRepos()).toEqual(new Set(["orgB/repoB1"]));
      dispose();
    });
  });

  it("toggleOrg selects an org without touching the repo set", () => {
    createRoot((dispose) => {
      const sel = createOrgRepoSelection({
        getOpen: () => true,
        getAvailableRepos: () => availableRepos,
        getInitialOrgs: () => [],
        getInitialRepos: () => [],
      });
      sel.toggleOrg("orgA");
      expect(sel.selectedOrgs()).toEqual(new Set(["orgA"]));
      expect(sel.selectedRepos()).toEqual(new Set());
      dispose();
    });
  });

  it("deselecting an org clears that org's member repos from the repo set", () => {
    createRoot((dispose) => {
      const sel = createOrgRepoSelection({
        getOpen: () => true,
        getAvailableRepos: () => availableRepos,
        getInitialOrgs: () => [],
        getInitialRepos: () => ["orgB/repoB1"],
      });
      sel.toggleOrg("orgA"); // select
      sel.toggleRepo("orgA/repoA1"); // individually select a member repo
      sel.toggleOrg("orgA"); // deselect — should clear orgA's repos only
      expect(sel.selectedOrgs()).toEqual(new Set());
      expect(sel.selectedRepos()).toEqual(new Set(["orgB/repoB1"]));
      dispose();
    });
  });

  it("toggleRepo toggles an individual repo without affecting the org set", () => {
    createRoot((dispose) => {
      const sel = createOrgRepoSelection({
        getOpen: () => true,
        getAvailableRepos: () => availableRepos,
        getInitialOrgs: () => [],
        getInitialRepos: () => [],
      });
      sel.toggleRepo("orgA/repoA1");
      expect(sel.selectedRepos()).toEqual(new Set(["orgA/repoA1"]));
      expect(sel.selectedOrgs()).toEqual(new Set());
      sel.toggleRepo("orgA/repoA1");
      expect(sel.selectedRepos()).toEqual(new Set());
      dispose();
    });
  });

  it("buildRepoList filters availableRepos by selectedRepos membership, dropping stale entries", () => {
    createRoot((dispose) => {
      const sel = createOrgRepoSelection({
        getOpen: () => true,
        getAvailableRepos: () => availableRepos,
        getInitialOrgs: () => [],
        getInitialRepos: () => ["orgA/repoA1", "stale/repo"],
      });
      expect(sel.buildRepoList()).toEqual([{ owner: "orgA", name: "repoA1", fullName: "orgA/repoA1" }]);
      dispose();
    });
  });

  it("resets selection from initial accessors when getOpen flips false→true", () => {
    let sel!: ReturnType<typeof createOrgRepoSelection>;
    let dispose!: () => void;
    let setOpen!: (v: boolean) => void;
    let setInitialOrgs!: (v: string[]) => void;

    createRoot((d) => {
      dispose = d;
      const [open, setOpenSignal] = createSignal(true);
      const [initialOrgs, setInitialOrgsSignal] = createSignal<string[]>(["orgA"]);
      setOpen = setOpenSignal;
      setInitialOrgs = setInitialOrgsSignal;
      sel = createOrgRepoSelection({
        getOpen: open,
        getAvailableRepos: () => availableRepos,
        getInitialOrgs: initialOrgs,
        getInitialRepos: () => [],
      });
    });

    sel.toggleOrg("orgB"); // in-progress edit
    expect(sel.selectedOrgs()).toEqual(new Set(["orgA", "orgB"]));

    setOpen(false);
    setInitialOrgs(["orgB"]);
    setOpen(true);

    expect(sel.selectedOrgs()).toEqual(new Set(["orgB"]));
    dispose();
  });
});

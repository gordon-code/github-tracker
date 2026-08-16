import { createSignal, createEffect, type Accessor } from "solid-js";
import type { RepoRef } from "../services/api";

export interface OrgRepoSelection {
  selectedOrgs: Accessor<Set<string>>;
  selectedRepos: Accessor<Set<string>>;
  toggleOrg: (org: string) => void;
  toggleRepo: (repoFullName: string) => void;
  buildRepoList: () => RepoRef[];
}

export interface OrgRepoSelectionOptions {
  getOpen: Accessor<boolean>;
  getAvailableRepos: Accessor<RepoRef[]>;
  getInitialOrgs: Accessor<string[]>;
  getInitialRepos: Accessor<string[]>;
}

// Deselecting an org clears its member repos from the repo selection Set;
// selecting an org never touches the repo set (OrgRepoCheckboxTree's
// checked-attribute OR handles display without needing individual repo entries).
export function createOrgRepoSelection(opts: OrgRepoSelectionOptions): OrgRepoSelection {
  const [selectedOrgs, setSelectedOrgs] = createSignal<Set<string>>(new Set(opts.getInitialOrgs()));
  const [selectedRepos, setSelectedRepos] = createSignal<Set<string>>(new Set(opts.getInitialRepos()));

  createEffect(() => {
    if (!opts.getOpen()) return;
    setSelectedOrgs(new Set(opts.getInitialOrgs()));
    setSelectedRepos(new Set(opts.getInitialRepos()));
  });

  function toggleOrg(org: string) {
    setSelectedOrgs((prev) => {
      const next = new Set(prev);
      if (next.has(org)) {
        next.delete(org);
        setSelectedRepos((prevRepos) => {
          const nextRepos = new Set(prevRepos);
          for (const r of opts.getAvailableRepos()) {
            if (r.owner === org) nextRepos.delete(r.fullName);
          }
          return nextRepos;
        });
      } else {
        next.add(org);
      }
      return next;
    });
  }

  function toggleRepo(repoFullName: string) {
    setSelectedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoFullName)) {
        next.delete(repoFullName);
      } else {
        next.add(repoFullName);
      }
      return next;
    });
  }

  function buildRepoList(): RepoRef[] {
    return opts.getAvailableRepos().filter((r) => selectedRepos().has(r.fullName));
  }

  return { selectedOrgs, selectedRepos, toggleOrg, toggleRepo, buildRepoList };
}

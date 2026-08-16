import { Dialog } from "@kobalte/core/dialog";
import type { RepoRef } from "../../services/api";
import { createOrgRepoSelection } from "../../lib/orgRepoSelection";
import OrgRepoCheckboxTree from "../shared/OrgRepoCheckboxTree";

interface DependencyExclusionModalProps {
  open: boolean;
  onClose: () => void;
  availableOrgs: string[];
  availableRepos: RepoRef[];
  excludedOrgs: string[];
  excludedRepos: RepoRef[];
  onSave: (excludedOrgs: string[], excludedRepos: RepoRef[]) => void;
}

export default function DependencyExclusionModal(props: DependencyExclusionModalProps) {
  const {
    selectedOrgs: excludedOrgs,
    selectedRepos: excludedRepos,
    toggleOrg,
    toggleRepo,
    buildRepoList: buildExcludedRepos,
  } = createOrgRepoSelection({
    getOpen: () => props.open,
    getAvailableRepos: () => props.availableRepos,
    getInitialOrgs: () => props.excludedOrgs,
    getInitialRepos: () => props.excludedRepos.map((r) => r.fullName),
  });

  function handleSave() {
    props.onSave([...excludedOrgs()], buildExcludedRepos());
    props.onClose();
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()} modal>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 bg-black/50 z-[70]" />
        <Dialog.Content class="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg bg-base-100 rounded-xl shadow-xl z-[71] flex flex-col max-h-[90vh]">
          <Dialog.Description class="sr-only">
            Manage repos and orgs excluded from the Dependencies tab
          </Dialog.Description>

          {/* Header */}
          <div class="flex items-center gap-2 px-5 py-4 border-b border-base-300 shrink-0">
            <Dialog.Title class="text-lg font-semibold flex-1">
              Exclude from Dependencies
            </Dialog.Title>
            <button
              type="button"
              class="btn btn-ghost btn-sm btn-circle"
              aria-label="Close"
              onClick={props.onClose}
            >
              ✕
            </button>
          </div>

          {/* Scrollable body */}
          <div class="overflow-y-auto flex-1 px-5 py-4 space-y-3">
            <p class="text-xs text-base-content/50">
              Repos and orgs checked below are hidden from the Dependencies tab only — their dependency-bot PRs won't reappear in Pull Requests, but regular issues, pull requests, and workflow runs are unaffected.
            </p>
            <div class="space-y-3">
              <OrgRepoCheckboxTree
                availableOrgs={props.availableOrgs}
                availableRepos={props.availableRepos}
                checkedOrgs={excludedOrgs()}
                checkedRepos={excludedRepos()}
                onToggleOrg={toggleOrg}
                onToggleRepo={toggleRepo}
                emptyMessage="No repos tracked yet."
              />
            </div>
          </div>

          {/* Footer */}
          <div class="flex items-center justify-end gap-2 px-5 py-4 border-t border-base-300 shrink-0">
            <button type="button" class="btn btn-ghost btn-sm" onClick={props.onClose}>
              Cancel
            </button>
            <button
              type="button"
              class="btn btn-primary btn-sm"
              onClick={handleSave}
            >
              Save
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}

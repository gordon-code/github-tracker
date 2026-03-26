import {
  createSignal,
  createMemo,
  onMount,
  Show,
  Switch,
  Match,
} from "solid-js";
import { config, updateConfig, CONFIG_STORAGE_KEY } from "../../stores/config";
import { fetchOrgs, type OrgEntry, type RepoRef } from "../../services/api";
import { getClient } from "../../services/github";
import RepoSelector from "./RepoSelector";
import LoadingSpinner from "../shared/LoadingSpinner";

export default function OnboardingWizard() {
  const [selectedRepos, setSelectedRepos] = createSignal<RepoRef[]>(
    config.selectedRepos.length > 0 ? [...config.selectedRepos] : []
  );

  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [orgEntries, setOrgEntries] = createSignal<OrgEntry[]>([]);

  const allOrgLogins = createMemo(() => orgEntries().map((o) => o.login));

  async function loadOrgs() {
    setLoading(true);
    setError(null);
    try {
      const client = getClient();
      if (!client) throw new Error("No GitHub client available");
      const result = await fetchOrgs(client);
      setOrgEntries(result);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load organizations"
      );
    } finally {
      setLoading(false);
    }
  }

  onMount(() => {
    if (config.onboardingComplete) {
      window.location.replace("/dashboard");
      return;
    }
    void loadOrgs();
  });

  function handleFinish() {
    const uniqueOrgs = [...new Set(selectedRepos().map((r) => r.owner))];
    updateConfig({
      selectedOrgs: uniqueOrgs,
      selectedRepos: selectedRepos(),
      onboardingComplete: true,
    });
    // Flush synchronously — the debounced persistence effect won't fire before page unload
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
    window.location.replace("/dashboard");
  }

  return (
    <div class="bg-base-200 min-h-screen">
      <div class="mx-auto max-w-2xl px-4 py-12">
        {/* Header */}
        <div class="mb-8 text-center">
          <h1 class="text-2xl font-bold text-base-content">
            GitHub Tracker Setup
          </h1>
          <p class="mt-1 text-sm text-base-content/60">
            Select the repositories you want to track.
          </p>
        </div>

        {/* Content */}
        <div class="card bg-base-100 shadow-lg">
          <div class="card-body">
            <Switch>
              <Match when={error()}>
                <div class="flex flex-col items-center gap-3 py-12">
                  <div class="alert alert-error text-sm">{error()}</div>
                  <button
                    type="button"
                    onClick={() => void loadOrgs()}
                    class="btn btn-sm btn-outline"
                  >
                    Retry
                  </button>
                </div>
              </Match>
              <Match when={loading()}>
                <div class="flex items-center justify-center py-12">
                  <LoadingSpinner size="md" label="Loading organizations..." />
                </div>
              </Match>
              <Match when={!loading() && !error()}>
                <div class="mb-5">
                  <h2 class="text-lg font-semibold text-base-content">
                    Select Repositories
                  </h2>
                  <p class="mt-1 text-sm text-base-content/60">
                    Choose which repositories to track.
                  </p>
                </div>
                <RepoSelector
                  selectedOrgs={allOrgLogins()}
                  orgEntries={orgEntries()}
                  selected={selectedRepos()}
                  onChange={setSelectedRepos}
                />
              </Match>
            </Switch>
          </div>
        </div>

        {/* Navigation buttons — hidden during loading/error to avoid confusion */}
        <Show when={!loading() && !error()}>
          <div class="mt-6 flex items-center justify-end">
            <button
              type="button"
              onClick={handleFinish}
              disabled={selectedRepos().length === 0}
              class="btn btn-primary"
            >
              {selectedRepos().length === 0
                ? "Finish Setup"
                : `Finish Setup (${selectedRepos().length} ${selectedRepos().length === 1 ? "repo" : "repos"})`}
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}

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
    <div class="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div class="mx-auto max-w-2xl px-4 py-12">
        {/* Header */}
        <div class="mb-8 text-center">
          <h1 class="text-2xl font-bold text-gray-900 dark:text-gray-100">
            GitHub Tracker Setup
          </h1>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Select the repositories you want to track.
          </p>
        </div>

        {/* Content */}
        <div class="rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <Switch>
            <Match when={error()}>
              <div class="flex flex-col items-center gap-3 py-12">
                <p class="text-sm text-red-600 dark:text-red-400">
                  {error()}
                </p>
                <button
                  type="button"
                  onClick={() => void loadOrgs()}
                  class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
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
                <h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  Select Repositories
                </h2>
                <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
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

        {/* Navigation buttons — hidden during loading/error to avoid confusion */}
        <Show when={!loading() && !error()}>
          <div class="mt-6 flex items-center justify-end">
            <button
              type="button"
              onClick={handleFinish}
              disabled={selectedRepos().length === 0}
              class="ml-auto rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-blue-500 dark:hover:bg-blue-600"
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

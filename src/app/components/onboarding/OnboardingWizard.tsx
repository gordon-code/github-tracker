import { createSignal, Show } from "solid-js";
import { config, updateConfig, CONFIG_STORAGE_KEY } from "../../stores/config";
import { RepoRef } from "../../services/api";
import OrgSelector from "./OrgSelector";
import RepoSelector from "./RepoSelector";

const STEPS = ["Select Organizations", "Select Repositories"] as const;

export default function OnboardingWizard() {
  const [step, setStep] = createSignal(0);
  const [selectedOrgs, setSelectedOrgs] = createSignal<string[]>(
    config.selectedOrgs.length > 0 ? [...config.selectedOrgs] : []
  );
  const [selectedRepos, setSelectedRepos] = createSignal<RepoRef[]>(
    config.selectedRepos.length > 0 ? [...config.selectedRepos] : []
  );

  function handleNext() {
    if (step() === 0) {
      updateConfig({ selectedOrgs: selectedOrgs() });
      setStep(1);
    }
  }

  function handleFinish() {
    updateConfig({
      selectedRepos: selectedRepos(),
      onboardingComplete: true,
    });
    // Flush synchronously — the debounced persistence effect won't fire before page unload
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
    window.location.replace("/dashboard");
  }

  function handleBack() {
    setStep((s) => Math.max(0, s - 1));
  }

  const canProceed = () => {
    if (step() === 0) return selectedOrgs().length > 0;
    return selectedRepos().length > 0;
  };

  return (
    <div class="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div class="mx-auto max-w-2xl px-4 py-12">
        {/* Header */}
        <div class="mb-8 text-center">
          <h1 class="text-2xl font-bold text-gray-900 dark:text-gray-100">
            GitHub Tracker Setup
          </h1>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Step {step() + 1} of {STEPS.length}
          </p>
        </div>

        {/* Step indicator */}
        <nav class="mb-8" aria-label="Progress">
          <ol class="flex items-center justify-center gap-4">
            {STEPS.map((label, i) => (
              <li class="flex items-center gap-2">
                <span
                  class={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                    i < step()
                      ? "bg-blue-600 text-white dark:bg-blue-500"
                      : i === step()
                        ? "bg-blue-600 text-white ring-4 ring-blue-100 dark:bg-blue-500 dark:ring-blue-900"
                        : "bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
                  }`}
                  aria-current={i === step() ? "step" : undefined}
                >
                  {i < step() ? (
                    <svg
                      class="h-4 w-4"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path
                        fill-rule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clip-rule="evenodd"
                      />
                    </svg>
                  ) : (
                    i + 1
                  )}
                </span>
                <span
                  class={`text-sm font-medium ${
                    i === step()
                      ? "text-gray-900 dark:text-gray-100"
                      : "text-gray-400 dark:text-gray-500"
                  }`}
                >
                  {label}
                </span>
                {i < STEPS.length - 1 && (
                  <span class="mx-2 text-gray-300 dark:text-gray-600">
                    &rsaquo;
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>

        {/* Step content */}
        <div class="rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <Show when={step() === 0}>
            <div class="mb-5">
              <h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Select Organizations
              </h2>
              <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Choose the GitHub organizations and personal account to track.
              </p>
            </div>
            <OrgSelector
              selected={selectedOrgs()}
              onChange={setSelectedOrgs}
            />
          </Show>

          <Show when={step() === 1}>
            <div class="mb-5">
              <h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Select Repositories
              </h2>
              <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Choose which repositories to track within your selected
                organizations.
              </p>
            </div>
            <RepoSelector
              selectedOrgs={selectedOrgs()}
              selected={selectedRepos()}
              onChange={setSelectedRepos}
            />
          </Show>
        </div>

        {/* Navigation buttons */}
        <div class="mt-6 flex items-center justify-between">
          <Show
            when={step() > 0}
            fallback={<div />}
          >
            <button
              type="button"
              onClick={handleBack}
              class="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              Back
            </button>
          </Show>

          <Show
            when={step() === STEPS.length - 1}
            fallback={
              <button
                type="button"
                onClick={handleNext}
                disabled={!canProceed()}
                class="ml-auto rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-blue-500 dark:hover:bg-blue-600"
              >
                Next
              </button>
            }
          >
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
          </Show>
        </div>
      </div>
    </div>
  );
}

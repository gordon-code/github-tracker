import { createSignal, createEffect, Show, onMount, onCleanup, JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { config, updateConfig } from "../../stores/config";
import { clearAuth } from "../../stores/auth";
import { clearCache } from "../../stores/cache";
import OrgSelector from "../onboarding/OrgSelector";
import RepoSelector from "../onboarding/RepoSelector";
import type { RepoRef } from "../../services/api";

// ── Theme application ──────────────────────────────────────────────────────

function applyTheme(theme: "light" | "dark" | "system"): void {
  const root = document.documentElement;
  if (theme === "dark") {
    root.classList.add("dark");
  } else if (theme === "light") {
    root.classList.remove("dark");
  } else {
    // system
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }
}

// ── Section wrapper ────────────────────────────────────────────────────────

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <div class="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div class="border-b border-gray-200 px-6 py-4 dark:border-gray-700">
        <h2 class="text-base font-semibold text-gray-900 dark:text-gray-100">
          {props.title}
        </h2>
      </div>
      <div class="px-6 py-5">{props.children}</div>
    </div>
  );
}

function SettingRow(props: {
  label: string;
  description?: string;
  children: JSX.Element;
}) {
  return (
    <div class="flex items-start justify-between gap-6 py-3 first:pt-0 last:pb-0">
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium text-gray-900 dark:text-gray-100">{props.label}</p>
        <Show when={props.description}>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{props.description}</p>
        </Show>
      </div>
      <div class="shrink-0">{props.children}</div>
    </div>
  );
}

// ── Toggle ─────────────────────────────────────────────────────────────────

function Toggle(props: {
  checked: boolean;
  onChange: (val: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      class={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 disabled:cursor-not-allowed disabled:opacity-40 ${
        props.checked ? "bg-blue-600" : "bg-gray-200 dark:bg-gray-600"
      }`}
    >
      <span
        class={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          props.checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

// ── Select ─────────────────────────────────────────────────────────────────

function Select<T extends string | number>(props: {
  value: T;
  onChange: (val: T) => void;
  options: { value: T; label: string }[];
  class?: string;
}) {
  return (
    <select
      value={String(props.value)}
      onChange={(e) => {
        const raw = e.currentTarget.value;
        // Attempt numeric coercion if original type is number
        const coerced =
          typeof props.value === "number" ? (Number(raw) as T) : (raw as T);
        props.onChange(coerced);
      }}
      class={`rounded-md border border-gray-300 bg-white py-1.5 pl-3 pr-8 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:focus:border-blue-400 dark:focus:ring-blue-400 ${props.class ?? ""}`}
    >
      {props.options.map((opt) => (
        <option value={String(opt.value)}>{opt.label}</option>
      ))}
    </select>
  );
}

// ── Number input ───────────────────────────────────────────────────────────

function NumberInput(props: {
  value: number;
  min: number;
  max: number;
  onChange: (val: number) => void;
}) {
  return (
    <input
      type="number"
      min={props.min}
      max={props.max}
      value={props.value}
      onInput={(e) => {
        const val = parseInt(e.currentTarget.value, 10);
        if (!isNaN(val) && val >= props.min && val <= props.max) {
          props.onChange(val);
        }
      }}
      class="w-20 rounded-md border border-gray-300 bg-white py-1.5 px-3 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:focus:border-blue-400 dark:focus:ring-blue-400"
    />
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function SettingsPage() {
  const navigate = useNavigate();

  // Local UI state for expandable panels
  const [orgPanelOpen, setOrgPanelOpen] = createSignal(false);
  const [repoPanelOpen, setRepoPanelOpen] = createSignal(false);
  const [confirmClearCache, setConfirmClearCache] = createSignal(false);
  const [confirmReset, setConfirmReset] = createSignal(false);
  const [cacheClearing, setCacheClearing] = createSignal(false);
  const [notifPermission, setNotifPermission] = createSignal<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "default"
  );

  // Save indicator
  const [showSaved, setShowSaved] = createSignal(false);
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  function saveWithFeedback(patch: Parameters<typeof updateConfig>[0]) {
    updateConfig(patch);
    clearTimeout(saveTimer);
    setShowSaved(true);
    saveTimer = setTimeout(() => setShowSaved(false), 1500);
  }

  onCleanup(() => clearTimeout(saveTimer));

  // Local copies for org/repo editing (committed on blur/change)
  const [localOrgs, setLocalOrgs] = createSignal<string[]>(config.selectedOrgs);
  const [localRepos, setLocalRepos] = createSignal<RepoRef[]>(config.selectedRepos);

  // Apply theme reactively
  createEffect(() => {
    const theme = config.theme;
    applyTheme(theme);
  });

  // System preference listener (only active when theme === "system")
  onMount(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (config.theme === "system") {
        applyTheme("system");
      }
    };
    mq.addEventListener("change", handler);
    onCleanup(() => mq.removeEventListener("change", handler));
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  function handleOrgsChange(orgs: string[]) {
    setLocalOrgs(orgs);
    saveWithFeedback({ selectedOrgs: orgs });
  }

  function handleReposChange(repos: RepoRef[]) {
    setLocalRepos(repos);
    saveWithFeedback({ selectedRepos: repos });
  }

  async function handleRequestNotificationPermission() {
    if (typeof Notification === "undefined") return;
    const perm = await Notification.requestPermission();
    setNotifPermission(perm);
    if (perm === "granted" && !config.notifications.enabled) {
      saveWithFeedback({ notifications: { ...config.notifications, enabled: true } });
    }
  }

  async function handleClearCache() {
    if (!confirmClearCache()) {
      setConfirmClearCache(true);
      return;
    }
    setCacheClearing(true);
    try {
      await clearCache();
    } finally {
      setCacheClearing(false);
      setConfirmClearCache(false);
    }
  }

  function handleExportSettings() {
    const data = JSON.stringify(
      {
        selectedOrgs: config.selectedOrgs,
        selectedRepos: config.selectedRepos,
        refreshInterval: config.refreshInterval,
        maxWorkflowsPerRepo: config.maxWorkflowsPerRepo,
        maxRunsPerWorkflow: config.maxRunsPerWorkflow,
        notifications: config.notifications,
        theme: config.theme,
        viewDensity: config.viewDensity,
        itemsPerPage: config.itemsPerPage,
        defaultTab: config.defaultTab,
        rememberLastTab: config.rememberLastTab,
      },
      null,
      2
    );
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "github-tracker-settings.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleResetAll() {
    if (!confirmReset()) {
      setConfirmReset(true);
      return;
    }
    // clearAuth handles: token + user signals, localStorage (auth/config/view),
    // IndexedDB cache, and onAuthCleared callbacks
    clearAuth();
    window.location.reload();
  }

  function handleSignOut() {
    clearAuth();
    navigate("/login");
  }

  // ── Refresh interval options ──────────────────────────────────────────────

  const refreshOptions = [
    { value: 60, label: "1 minute" },
    { value: 120, label: "2 minutes" },
    { value: 300, label: "5 minutes (default)" },
    { value: 600, label: "10 minutes" },
    { value: 900, label: "15 minutes" },
    { value: 1800, label: "30 minutes" },
    { value: 0, label: "Off" },
  ];

  const tabOptions = [
    { value: "issues" as const, label: "Issues" },
    { value: "pullRequests" as const, label: "Pull Requests" },
    { value: "actions" as const, label: "GitHub Actions" },
  ];

  const themeOptions = [
    { value: "system" as const, label: "System" },
    { value: "light" as const, label: "Light" },
    { value: "dark" as const, label: "Dark" },
  ];

  const densityOptions = [
    { value: "comfortable" as const, label: "Comfortable" },
    { value: "compact" as const, label: "Compact" },
  ];

  const itemsPerPageOptions = [
    { value: 10, label: "10" },
    { value: 25, label: "25" },
    { value: 50, label: "50" },
    { value: 100, label: "100" },
  ];

  return (
    <div class="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Page header */}
      <div class="border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
        <div class="mx-auto max-w-3xl px-4 py-6 sm:px-6">
          <div class="flex items-center gap-3">
            <a
              href="/dashboard"
              class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              aria-label="Back to dashboard"
            >
              <svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path
                  fill-rule="evenodd"
                  d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z"
                  clip-rule="evenodd"
                />
              </svg>
            </a>
            <h1 class="text-2xl font-bold text-gray-900 dark:text-gray-100">Settings</h1>
            <Show when={showSaved()}>
              <span class="ml-auto text-sm font-medium text-green-600 dark:text-green-400 animate-pulse">
                Saved
              </span>
            </Show>
          </div>
        </div>
      </div>

      <div class="mx-auto max-w-3xl px-4 py-8 sm:px-6 flex flex-col gap-6">
        {/* Section 1: Orgs & Repos */}
        <Section title="Organizations & Repositories">
          <div class="flex flex-col gap-3">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm font-medium text-gray-900 dark:text-gray-100">Organizations</p>
                <p class="text-xs text-gray-500 dark:text-gray-400">
                  {localOrgs().length} selected
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOrgPanelOpen((v) => !v)}
                class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
              >
                Manage Organizations
              </button>
            </div>
            <Show when={orgPanelOpen()}>
              <div class="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
                <OrgSelector
                  selected={localOrgs()}
                  onChange={handleOrgsChange}
                />
              </div>
            </Show>

            <div class="border-t border-gray-100 pt-3 dark:border-gray-700 flex items-center justify-between">
              <div>
                <p class="text-sm font-medium text-gray-900 dark:text-gray-100">Repositories</p>
                <p class="text-xs text-gray-500 dark:text-gray-400">
                  {localRepos().length} selected
                </p>
                <Show when={localRepos().length > 50}>
                  <p class="text-xs text-amber-600 dark:text-amber-400">
                    Tracking {localRepos().length} repos will use significant API quota per poll cycle
                  </p>
                </Show>
              </div>
              <button
                type="button"
                onClick={() => setRepoPanelOpen((v) => !v)}
                class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
              >
                Manage Repositories
              </button>
            </div>
            <Show when={repoPanelOpen()}>
              <div class="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
                <RepoSelector
                  selectedOrgs={localOrgs()}
                  selected={localRepos()}
                  onChange={handleReposChange}
                />
              </div>
            </Show>
          </div>
        </Section>

        {/* Section 2: Refresh */}
        <Section title="Refresh">
          <SettingRow
            label="Refresh interval"
            description="How often to poll GitHub for new data"
          >
            <Select
              value={config.refreshInterval}
              onChange={(val) => saveWithFeedback({ refreshInterval: val })}
              options={refreshOptions}
            />
          </SettingRow>
        </Section>

        {/* Section 3: GitHub Actions */}
        <Section title="GitHub Actions">
          <div class="divide-y divide-gray-100 dark:divide-gray-700">
            <SettingRow
              label="Max workflows per repo"
              description="Number of active workflows to track per repository (1–20)"
            >
              <NumberInput
                value={config.maxWorkflowsPerRepo}
                min={1}
                max={20}
                onChange={(val) => saveWithFeedback({ maxWorkflowsPerRepo: val })}
              />
            </SettingRow>
            <SettingRow
              label="Max runs per workflow"
              description="Number of recent runs to show per workflow (1–10)"
            >
              <NumberInput
                value={config.maxRunsPerWorkflow}
                min={1}
                max={10}
                onChange={(val) => saveWithFeedback({ maxRunsPerWorkflow: val })}
              />
            </SettingRow>
          </div>
        </Section>

        {/* Section 4: Notifications */}
        <Section title="Notifications">
          <div class="divide-y divide-gray-100 dark:divide-gray-700">
            <SettingRow
              label="Enable notifications"
              description="Show browser notifications for new activity"
            >
              <div class="flex items-center gap-3">
                <Show when={notifPermission() !== "granted" && !config.notifications.enabled}>
                  <button
                    type="button"
                    onClick={() => void handleRequestNotificationPermission()}
                    class="text-xs text-blue-600 hover:underline dark:text-blue-400"
                  >
                    Grant permission
                  </button>
                </Show>
                <Show when={notifPermission() === "denied"}>
                  <span class="text-xs text-red-500 dark:text-red-400">
                    Permission denied in browser
                  </span>
                </Show>
                <Toggle
                  checked={config.notifications.enabled}
                  disabled={notifPermission() === "denied"}
                  label="Enable notifications"
                  onChange={(val) => {
                    if (val && notifPermission() !== "granted") {
                      void handleRequestNotificationPermission();
                    } else {
                      saveWithFeedback({
                        notifications: { ...config.notifications, enabled: val },
                      });
                    }
                  }}
                />
              </div>
            </SettingRow>
            <SettingRow label="Issues" description="Notify when new issues are opened">
              <Toggle
                checked={config.notifications.issues}
                disabled={!config.notifications.enabled}
                label="Issues notifications"
                onChange={(val) =>
                  saveWithFeedback({
                    notifications: { ...config.notifications, issues: val },
                  })
}
              />
            </SettingRow>
            <SettingRow label="Pull Requests" description="Notify when PRs are opened or updated">
              <Toggle
                checked={config.notifications.pullRequests}
                disabled={!config.notifications.enabled}
                label="Pull requests notifications"
                onChange={(val) =>
                  saveWithFeedback({
                    notifications: { ...config.notifications, pullRequests: val },
                  })
                }
              />
            </SettingRow>
            <SettingRow label="Workflow Runs" description="Notify when workflow runs complete">
              <Toggle
                checked={config.notifications.workflowRuns}
                disabled={!config.notifications.enabled}
                label="Workflow runs notifications"
                onChange={(val) =>
                  saveWithFeedback({
                    notifications: { ...config.notifications, workflowRuns: val },
                  })
                }
              />
            </SettingRow>
          </div>
        </Section>

        {/* Section 5: Appearance */}
        <Section title="Appearance">
          <div class="divide-y divide-gray-100 dark:divide-gray-700">
            <SettingRow label="Theme">
              <Select
                value={config.theme}
                onChange={(val) => saveWithFeedback({ theme: val })}
                options={themeOptions}
              />
            </SettingRow>
            <SettingRow
              label="View density"
              description="Controls spacing between items in lists"
            >
              <Select
                value={config.viewDensity}
                onChange={(val) => saveWithFeedback({ viewDensity: val })}
                options={densityOptions}
              />
            </SettingRow>
            <SettingRow
              label="Items per page"
              description="Number of items to show in each tab"
            >
              <Select
                value={config.itemsPerPage}
                onChange={(val) => saveWithFeedback({ itemsPerPage: val })}
                options={itemsPerPageOptions}
              />
            </SettingRow>
          </div>
        </Section>

        {/* Section 6: Tabs */}
        <Section title="Tabs">
          <div class="divide-y divide-gray-100 dark:divide-gray-700">
            <SettingRow
              label="Default tab"
              description="Tab shown when opening the dashboard fresh"
            >
              <Select
                value={config.defaultTab}
                onChange={(val) => saveWithFeedback({ defaultTab: val })}
                options={tabOptions}
              />
            </SettingRow>
            <SettingRow
              label="Remember last tab"
              description="Return to the last active tab on revisit"
            >
              <Toggle
                checked={config.rememberLastTab}
                label="Remember last tab"
                onChange={(val) => saveWithFeedback({ rememberLastTab: val })}
              />
            </SettingRow>
          </div>
        </Section>

        {/* Section 7: Data */}
        <Section title="Data">
          <div class="divide-y divide-gray-100 dark:divide-gray-700">
            {/* Clear cache */}
            <SettingRow
              label="Clear cache"
              description="Remove all cached API responses from IndexedDB"
            >
              <Show
                when={!confirmClearCache()}
                fallback={
                  <div class="flex items-center gap-2">
                    <span class="text-xs text-gray-600 dark:text-gray-400">Are you sure?</span>
                    <button
                      type="button"
                      onClick={() => void handleClearCache()}
                      disabled={cacheClearing()}
                      class="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {cacheClearing() ? "Clearing..." : "Yes, clear"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmClearCache(false)}
                      class="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                    >
                      Cancel
                    </button>
                  </div>
                }
              >
                <button
                  type="button"
                  onClick={() => void handleClearCache()}
                  class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                >
                  Clear cache
                </button>
              </Show>
            </SettingRow>

            {/* Export settings */}
            <SettingRow
              label="Export settings"
              description="Download your configuration as a JSON file"
            >
              <button
                type="button"
                onClick={handleExportSettings}
                class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
              >
                Export
              </button>
            </SettingRow>

            {/* Reset all */}
            <SettingRow
              label="Reset all"
              description="Clear all settings, cache, and auth — reloads the page"
            >
              <Show
                when={!confirmReset()}
                fallback={
                  <div class="flex items-center gap-2">
                    <span class="text-xs text-gray-600 dark:text-gray-400">Are you sure?</span>
                    <button
                      type="button"
                      onClick={() => handleResetAll()}
                      class="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
                    >
                      Yes, reset
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmReset(false)}
                      class="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                    >
                      Cancel
                    </button>
                  </div>
                }
              >
                <button
                  type="button"
                  onClick={() => handleResetAll()}
                  class="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-700 dark:bg-gray-700 dark:text-red-400 dark:hover:bg-red-900/20"
                >
                  Reset all
                </button>
              </Show>
            </SettingRow>

            {/* Sign out */}
            <SettingRow
              label="Sign out"
              description="Clear auth tokens and return to login"
            >
              <button
                type="button"
                onClick={handleSignOut}
                class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
              >
                Sign out
              </button>
            </SettingRow>
          </div>
        </Section>
      </div>
    </div>
  );
}

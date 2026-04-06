import { createSignal, createMemo, Show, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { config, updateConfig, setMonitoredRepo } from "../../stores/config";
import { clearAuth } from "../../stores/auth";
import { clearCache } from "../../stores/cache";
import { pushNotification } from "../../lib/errors";
import { buildOrgAccessUrl } from "../../lib/oauth";
import { isSafeGitHubUrl, openGitHubUrl } from "../../lib/url";
import { fetchOrgs } from "../../services/api";
import { getClient } from "../../services/github";
import OrgSelector from "../onboarding/OrgSelector";
import RepoSelector from "../onboarding/RepoSelector";
import Section from "./Section";
import SettingRow from "./SettingRow";
import ThemePicker from "./ThemePicker";
import TrackedUsersSection from "./TrackedUsersSection";
import { InfoTooltip } from "../shared/Tooltip";
import type { RepoRef } from "../../services/api";

export default function SettingsPage() {
  const navigate = useNavigate();

  // Local UI state for expandable panels
  const [orgPanelOpen, setOrgPanelOpen] = createSignal(false);
  const [repoPanelOpen, setRepoPanelOpen] = createSignal(false);
  const [confirmClearCache, setConfirmClearCache] = createSignal(false);
  const [confirmReset, setConfirmReset] = createSignal(false);
  const [cacheClearing, setCacheClearing] = createSignal(false);
  const [merging, setMerging] = createSignal(false);
  const [notifPermission, setNotifPermission] = createSignal<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "default"
  );

  // Save indicator
  const [showSaved, setShowSaved] = createSignal(false);
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingFocusHandler: (() => void) | undefined;

  function saveWithFeedback(patch: Parameters<typeof updateConfig>[0]) {
    updateConfig(patch);
    clearTimeout(saveTimer);
    setShowSaved(true);
    saveTimer = setTimeout(() => setShowSaved(false), 1500);
  }

  onCleanup(() => {
    clearTimeout(saveTimer);
    if (pendingFocusHandler) {
      window.removeEventListener("focus", pendingFocusHandler);
    }
  });

  // Local copies for org/repo editing (committed on blur/change)
  const [localOrgs, setLocalOrgs] = createSignal<string[]>(config.selectedOrgs);
  const [localRepos, setLocalRepos] = createSignal<RepoRef[]>(config.selectedRepos);
  const [localUpstream, setLocalUpstream] = createSignal<RepoRef[]>(config.upstreamRepos);

  const monitoredRepoNames = createMemo(() =>
    config.monitoredRepos.map(r => r.fullName).join(", ")
  );

  // ── Helpers ──────────────────────────────────────────────────────────────

  async function mergeNewOrgs() {
    const client = getClient();
    if (!client) return;
    setMerging(true);
    const snapshot = [...config.selectedOrgs];
    try {
      const allOrgs = await fetchOrgs(client);
      // Case-insensitive comparison — GitHub logins are case-insensitive
      const currentSet = new Set(snapshot.map((o) => o.toLowerCase()));
      const newOrgs = allOrgs
        .map((o) => o.login)
        .filter((login) => !currentSet.has(login.toLowerCase()));
      if (newOrgs.length > 0) {
        const merged = [...snapshot, ...newOrgs];
        setLocalOrgs(merged);
        saveWithFeedback({ selectedOrgs: merged });
        console.info(`[settings] merged ${newOrgs.length} new org(s)`);
      }
    } catch {
      pushNotification("org-sync", "Failed to sync organizations — try again or manage manually", "warning");
    } finally {
      setMerging(false);
    }
  }

  function handleGrantOrgs() {
    const url = buildOrgAccessUrl();
    if (!isSafeGitHubUrl(url)) return;
    openGitHubUrl(url);
    // Remove any prior focus listener before adding a new one (dedup on rapid clicks)
    if (pendingFocusHandler) {
      window.removeEventListener("focus", pendingFocusHandler);
    }
    const onFocus = () => {
      window.removeEventListener("focus", onFocus);
      pendingFocusHandler = undefined;
      void mergeNewOrgs();
    };
    pendingFocusHandler = onFocus;
    window.addEventListener("focus", onFocus);
  }

  function handleOrgsChange(orgs: string[]) {
    setLocalOrgs(orgs);
    saveWithFeedback({ selectedOrgs: orgs });
  }

  function handleReposChange(repos: RepoRef[]) {
    setLocalRepos(repos);
    saveWithFeedback({ selectedRepos: repos });
  }

  function handleUpstreamChange(repos: RepoRef[]) {
    setLocalUpstream(repos);
    saveWithFeedback({ upstreamRepos: repos });
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
        upstreamRepos: config.upstreamRepos,
        monitoredRepos: config.monitoredRepos,
        trackedUsers: config.trackedUsers,
        refreshInterval: config.refreshInterval,
        hotPollInterval: config.hotPollInterval,
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
    <div class="bg-base-200 min-h-screen">
      {/* Page header */}
      <div class="border-b border-base-300 bg-base-100">
        <div class="mx-auto max-w-3xl px-4 py-6 sm:px-6">
          <div class="flex items-center gap-3">
            <a
              href="/dashboard"
              class="text-base-content/40 hover:text-base-content/60"
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
            <h1 class="text-2xl font-bold text-base-content">Settings</h1>
            <Show when={showSaved()}>
              <span class="ml-auto text-sm font-medium text-success animate-pulse">
                Saved
              </span>
            </Show>
          </div>
        </div>
      </div>

      <div class="mx-auto max-w-3xl px-4 py-8 sm:px-6 flex flex-col gap-6">
        {/* Section 1: Orgs & Repos */}
        <Section title="Organizations & Repositories">
          <div class="flex flex-col gap-3 px-4 py-3">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm font-medium text-base-content">Organizations</p>
                <p class="text-xs text-base-content/60">
                  {localOrgs().length} selected
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOrgPanelOpen((v) => !v)}
                class="btn btn-sm btn-outline"
              >
                Manage Organizations
              </button>
            </div>
            <Show when={orgPanelOpen()}>
              <div class="rounded-lg border border-base-300 p-4">
                <OrgSelector
                  selected={localOrgs()}
                  onChange={handleOrgsChange}
                />
              </div>
            </Show>

            <Show when={config.authMethod !== "pat"}>
              <div class="border-t border-base-300 pt-3">
                <div class="flex items-center justify-between">
                  <div>
                    <p class="text-sm font-medium text-base-content">
                      Organization Access
                    </p>
                    <p class="text-xs text-base-content/60">
                      Request access for restricted orgs on GitHub — new orgs sync when you return
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleGrantOrgs}
                    disabled={merging()}
                    class="btn btn-sm btn-outline"
                  >
                    {merging() ? "Syncing..." : "Manage org access"}
                  </button>
                </div>
              </div>
            </Show>

            <div class="border-t border-base-300 pt-3">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-sm font-medium text-base-content">Repositories</p>
                  <p class="text-xs text-base-content/60">
                    {localRepos().length + localUpstream().length} selected{localUpstream().length > 0 ? ` (${localUpstream().length} upstream)` : ""}
                  </p>
                  <Show when={localRepos().length > 50}>
                    <p class="text-xs text-warning">
                      Tracking {localRepos().length} repos will use significant API quota per poll cycle
                    </p>
                  </Show>
                  <Show when={config.monitoredRepos.length > 0}>
                    <p class="text-xs text-info flex items-center gap-1 mt-0.5">
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width={2} aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                      Monitoring all: {monitoredRepoNames()}
                    </p>
                  </Show>
                </div>
                <button
                  type="button"
                  onClick={() => setRepoPanelOpen((v) => !v)}
                  class="btn btn-sm btn-outline"
                >
                  Manage Repositories
                </button>
              </div>
            </div>
            <Show when={repoPanelOpen()}>
              <div class="rounded-lg border border-base-300 p-4">
                <RepoSelector
                  selectedOrgs={localOrgs()}
                  selected={localRepos()}
                  onChange={handleReposChange}
                  showUpstreamDiscovery={true}
                  upstreamRepos={localUpstream()}
                  onUpstreamChange={handleUpstreamChange}
                  trackedUsers={config.trackedUsers}
                  monitoredRepos={config.monitoredRepos}
                  onMonitorToggle={setMonitoredRepo}
                />
              </div>
            </Show>
          </div>
        </Section>

        {/* Section 2: Tracked Users */}
        <Section title="Tracked Users">
          <div class="flex flex-col gap-3 px-4 py-3">
            <p class="text-xs text-base-content/60">
              Track another GitHub user's issues and pull requests alongside yours.
            </p>
            <TrackedUsersSection
              users={config.trackedUsers}
              onSave={(users) => saveWithFeedback({ trackedUsers: users })}
            />
          </div>
        </Section>

        {/* Section 3: Refresh */}
        <Section title="Refresh">
          <SettingRow
            label="Refresh interval"
            description="How often to poll GitHub for new data"
          >
            <select
              value={String(config.refreshInterval)}
              onChange={(e) => {
                saveWithFeedback({ refreshInterval: Number(e.currentTarget.value) });
              }}
              class="select select-sm"
            >
              {refreshOptions.map((opt) => (
                <option value={String(opt.value)}>{opt.label}</option>
              ))}
            </select>
          </SettingRow>
          <div class="flex items-center justify-between px-4 py-3 border-b border-base-300 last:border-b-0">
            <div>
              <div class="flex items-center gap-1.5 text-sm font-medium text-base-content">
                CI status refresh
                <InfoTooltip content="Targeted refresh for in-flight CI checks and pending PR status. Separate from the full refresh cycle." />
              </div>
              <div class="text-xs text-base-content/60">How often to re-check in-flight CI checks and workflow runs (10-120s)</div>
            </div>
            <div>
              <input
                type="number"
                min={10}
                max={120}
                value={config.hotPollInterval}
                onInput={(e) => {
                  const val = parseInt(e.currentTarget.value, 10);
                  if (!isNaN(val) && val >= 10 && val <= 120) {
                    saveWithFeedback({ hotPollInterval: val });
                  }
                }}
                class="input input-sm w-20"
              />
            </div>
          </div>
        </Section>

        {/* Section 4: GitHub Actions */}
        <Section title="GitHub Actions">
          <SettingRow
            label="Max workflows per repo"
            description="Number of active workflows to track per repository (1–20)"
          >
            <input
              type="number"
              min={1}
              max={20}
              value={config.maxWorkflowsPerRepo}
              onInput={(e) => {
                const val = parseInt(e.currentTarget.value, 10);
                if (!isNaN(val) && val >= 1 && val <= 20) {
                  saveWithFeedback({ maxWorkflowsPerRepo: val });
                }
              }}
              class="input input-sm w-20"
            />
          </SettingRow>
          <SettingRow
            label="Max runs per workflow"
            description="Number of recent runs to show per workflow (1–10)"
          >
            <input
              type="number"
              min={1}
              max={10}
              value={config.maxRunsPerWorkflow}
              onInput={(e) => {
                const val = parseInt(e.currentTarget.value, 10);
                if (!isNaN(val) && val >= 1 && val <= 10) {
                  saveWithFeedback({ maxRunsPerWorkflow: val });
                }
              }}
              class="input input-sm w-20"
            />
          </SettingRow>
        </Section>

        {/* Section 5: Notifications */}
        <Section title="Notifications">
          <SettingRow
            label="Enable notifications"
            description="Show browser notifications for new activity"
          >
            <div class="flex items-center gap-3">
              <Show when={notifPermission() !== "granted" && !config.notifications.enabled}>
                <button
                  type="button"
                  onClick={() => void handleRequestNotificationPermission()}
                  class="btn btn-ghost btn-xs"
                >
                  Grant permission
                </button>
              </Show>
              <Show when={notifPermission() === "denied"}>
                <span class="text-xs text-error">
                  Permission denied in browser
                </span>
              </Show>
              <input
                type="checkbox"
                role="switch"
                aria-checked={config.notifications.enabled}
                aria-label="Enable notifications"
                checked={config.notifications.enabled}
                disabled={notifPermission() === "denied"}
                onChange={(e) => {
                  const val = e.currentTarget.checked;
                  if (val && notifPermission() !== "granted") {
                    void handleRequestNotificationPermission();
                  } else {
                    saveWithFeedback({
                      notifications: { ...config.notifications, enabled: val },
                    });
                  }
                }}
                class="toggle toggle-primary"
              />
            </div>
          </SettingRow>
          <SettingRow label="Issues" description="Notify when new issues are opened">
            <input
              type="checkbox"
              role="switch"
              aria-checked={config.notifications.issues}
              aria-label="Issues notifications"
              checked={config.notifications.issues}
              disabled={!config.notifications.enabled}
              onChange={(e) =>
                saveWithFeedback({
                  notifications: { ...config.notifications, issues: e.currentTarget.checked },
                })
              }
              class="toggle toggle-primary"
            />
          </SettingRow>
          <SettingRow label="Pull Requests" description="Notify when PRs are opened or updated">
            <input
              type="checkbox"
              role="switch"
              aria-checked={config.notifications.pullRequests}
              aria-label="Pull requests notifications"
              checked={config.notifications.pullRequests}
              disabled={!config.notifications.enabled}
              onChange={(e) =>
                saveWithFeedback({
                  notifications: { ...config.notifications, pullRequests: e.currentTarget.checked },
                })
              }
              class="toggle toggle-primary"
            />
          </SettingRow>
          <SettingRow label="Workflow Runs" description="Notify when workflow runs complete">
            <input
              type="checkbox"
              role="switch"
              aria-checked={config.notifications.workflowRuns}
              aria-label="Workflow runs notifications"
              checked={config.notifications.workflowRuns}
              disabled={!config.notifications.enabled}
              onChange={(e) =>
                saveWithFeedback({
                  notifications: { ...config.notifications, workflowRuns: e.currentTarget.checked },
                })
              }
              class="toggle toggle-primary"
            />
          </SettingRow>
        </Section>

        {/* Section 6: Appearance */}
        <Section title="Appearance">
          <div class="px-4 py-2 border-b border-base-300">
            <p class="text-sm font-medium text-base-content mb-2">Theme</p>
            <ThemePicker />
          </div>
          <SettingRow
            label="View density"
            description="Controls spacing between items in lists"
          >
            <select
              value={config.viewDensity}
              onChange={(e) => {
                saveWithFeedback({ viewDensity: e.currentTarget.value as "comfortable" | "compact" });
              }}
              class="select select-sm"
            >
              {densityOptions.map((opt) => (
                <option value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </SettingRow>
          <SettingRow
            label="Items per page"
            description="Number of items to show in each tab"
          >
            <select
              value={String(config.itemsPerPage)}
              onChange={(e) => {
                saveWithFeedback({ itemsPerPage: Number(e.currentTarget.value) });
              }}
              class="select select-sm"
            >
              {itemsPerPageOptions.map((opt) => (
                <option value={String(opt.value)}>{opt.label}</option>
              ))}
            </select>
          </SettingRow>
        </Section>

        {/* Section 7: Tabs */}
        <Section title="Tabs">
          <SettingRow
            label="Default tab"
            description="Tab shown when opening the dashboard fresh"
          >
            <select
              value={config.defaultTab}
              onChange={(e) => {
                saveWithFeedback({ defaultTab: e.currentTarget.value as "issues" | "pullRequests" | "actions" });
              }}
              class="select select-sm"
            >
              {tabOptions.map((opt) => (
                <option value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </SettingRow>
          <SettingRow
            label="Remember last tab"
            description="Return to the last active tab on revisit"
          >
            <input
              type="checkbox"
              role="switch"
              aria-checked={config.rememberLastTab}
              aria-label="Remember last tab"
              checked={config.rememberLastTab}
              onChange={(e) => saveWithFeedback({ rememberLastTab: e.currentTarget.checked })}
              class="toggle toggle-primary"
            />
          </SettingRow>
        </Section>

        {/* Section 8: Data */}
        <Section title="Data">
          {/* Authentication method */}
          <SettingRow
            label="Authentication"
            description="Current sign-in method"
          >
            <span class="text-sm">{config.authMethod === "pat" ? "Personal Access Token" : "OAuth"}</span>
          </SettingRow>

          {/* Clear cache */}
          <SettingRow
            label="Clear cache"
            description="Remove all cached API responses from IndexedDB"
          >
            <Show
              when={!confirmClearCache()}
              fallback={
                <div class="flex items-center gap-2">
                  <span class="text-xs text-base-content/60">Are you sure?</span>
                  <button
                    type="button"
                    onClick={() => void handleClearCache()}
                    disabled={cacheClearing()}
                    class="btn btn-error btn-xs"
                  >
                    {cacheClearing() ? "Clearing..." : "Yes, clear"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClearCache(false)}
                    class="btn btn-ghost btn-xs"
                  >
                    Cancel
                  </button>
                </div>
              }
            >
              <button
                type="button"
                onClick={() => void handleClearCache()}
                class="btn btn-sm btn-outline"
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
              class="btn btn-sm btn-outline"
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
                  <span class="text-xs text-base-content/60">Are you sure?</span>
                  <button
                    type="button"
                    onClick={() => handleResetAll()}
                    class="btn btn-error btn-xs"
                  >
                    Yes, reset
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmReset(false)}
                    class="btn btn-ghost btn-xs"
                  >
                    Cancel
                  </button>
                </div>
              }
            >
              <button
                type="button"
                onClick={() => handleResetAll()}
                class="btn btn-sm btn-error btn-outline"
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
              class="btn btn-sm btn-outline"
            >
              Sign out
            </button>
          </SettingRow>
        </Section>

        <footer class="mt-8 border-t border-base-300 pt-4 pb-8 text-xs text-base-content/50 text-center">
          <div class="flex items-center justify-center gap-3">
            <a
              href="https://github.com/gordon-code/github-tracker"
              target="_blank"
              rel="noopener noreferrer"
              class="link link-hover"
            >
              Source
            </a>
            <span aria-hidden="true">·</span>
            <a
              href="https://github.com/gordon-code/github-tracker/blob/main/docs/USER_GUIDE.md"
              target="_blank"
              rel="noopener noreferrer"
              class="link link-hover"
            >
              Guide
            </a>
            <span aria-hidden="true">·</span>
            <a
              href="/privacy"
              class="link link-hover"
            >
              Privacy
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
}

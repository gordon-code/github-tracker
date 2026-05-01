import { createSignal, createMemo, Show, For, onCleanup, onMount } from "solid-js";
import * as Sentry from "@sentry/solid";
import { getRelayStatus } from "../../lib/mcp-relay";
import { useNavigate } from "@solidjs/router";
import { config, updateConfig, updateJiraConfig, updateJiraCustomFields, updateJiraCustomScopes, setMonitoredRepo } from "../../stores/config";
import type { Config } from "../../stores/config";
import { viewState, updateViewState } from "../../stores/view";
import { clearAuth, jiraAuth, setJiraAuth, clearJiraConfigFull, isJiraAuthenticated } from "../../stores/auth";
import { clearCache } from "../../stores/cache";
import { pushNotification } from "../../lib/errors";
import { buildOrgAccessUrl, buildJiraAuthorizeUrl } from "../../lib/oauth";
import { sealApiToken } from "../../lib/proxy";
import { isSafeGitHubUrl, openGitHubUrl } from "../../lib/url";
import { relativeTime } from "../../lib/format";
import { fetchOrgs } from "../../services/api";
import { getClient } from "../../services/github";
import { getUsageSnapshot, getUsageResetAt, resetUsageData, checkAndResetIfExpired, SOURCE_LABELS } from "../../services/api-usage";
import OrgSelector from "../onboarding/OrgSelector";
import RepoSelector from "../onboarding/RepoSelector";
import Section from "./Section";
import SettingRow from "./SettingRow";
import ThemePicker from "./ThemePicker";
import DensityPicker from "./DensityPicker";
import TrackedUsersSection from "./TrackedUsersSection";
import CustomTabsSection from "./CustomTabsSection";
import { InfoTooltip } from "../shared/Tooltip";
import { createJiraClient } from "../../lib/jira-utils";
import JiraFieldPicker from "./JiraFieldPicker";
import JiraScopePicker from "./JiraScopePicker";
import type { RepoRef } from "../../services/api";

const VALID_JIRA_CLIENT_ID_RE = /^[A-Za-z0-9_-]+$/;

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

  onMount(() => checkAndResetIfExpired());
  const usageSnapshot = createMemo(() => getUsageSnapshot());

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
        enableTracking: config.enableTracking,
        customTabs: config.customTabs,
        // Non-secret jira config fields only — no tokens, sealed blobs, or email
        jira: {
          enabled: config.jira?.enabled ?? false,
          authMethod: config.jira?.authMethod ?? "oauth",
          issueKeyDetection: config.jira?.issueKeyDetection ?? true,
          cloudId: config.jira?.cloudId,
          siteName: config.jira?.siteName,
          siteUrl: config.jira?.siteUrl,
          customFields: config.jira?.customFields ?? [],
          customScopes: config.jira?.customScopes ?? [],
        },
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

  // ── Jira integration ──────────────────────────────────────────────────────

  const jiraClientId = import.meta.env.VITE_JIRA_CLIENT_ID as string | undefined;
  const jiraEnabled = !!jiraClientId && VALID_JIRA_CLIENT_ID_RE.test(jiraClientId);

  const [jiraApiEmail, setJiraApiEmail] = createSignal("");
  const [jiraApiToken, setJiraApiToken] = createSignal("");
  const [jiraApiSubdomain, setJiraApiSubdomain] = createSignal("");
  const [jiraApiConnecting, setJiraApiConnecting] = createSignal(false);
  const [jiraApiError, setJiraApiError] = createSignal<string | null>(null);
  const [jiraApiMode, setJiraApiMode] = createSignal(false);
  const [showFieldPicker, setShowFieldPicker] = createSignal(false);
  const [showScopePicker, setShowScopePicker] = createSignal(false);

  const jiraClient = createMemo(() => createJiraClient(config.jira?.authMethod));

  const jiraApiSiteUrl = () => {
    const sub = jiraApiSubdomain().trim();
    return sub ? `https://${sub}.atlassian.net` : "";
  };

  function handleJiraOAuthConnect() {
    try {
      const url = buildJiraAuthorizeUrl();
      window.location.href = url;
    } catch {
      pushNotification("jira:connect", "Jira client ID is not configured — check VITE_JIRA_CLIENT_ID", "warning");
    }
  }

  async function handleJiraApiTokenConnect() {
    const email = jiraApiEmail().trim();
    const token = jiraApiToken().trim();
    const siteUrl = jiraApiSiteUrl();
    if (!email || !token || !siteUrl) {
      setJiraApiError("Email, API token, and site name are all required.");
      return;
    }
    setJiraApiConnecting(true);
    setJiraApiError(null);
    try {
      // Auto-discover Cloud ID from site URL
      const tenantResp = await fetch("/api/jira/tenant-info", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
        body: JSON.stringify({ siteUrl }),
      });
      if (!tenantResp.ok) {
        setJiraApiError("Could not look up your Jira site — check the site URL and try again.");
        return;
      }
      const tenantData = await tenantResp.json() as { cloudId: string };
      const cloudId = tenantData.cloudId;
      if (!cloudId) {
        setJiraApiError("Could not determine Cloud ID from your Jira site URL.");
        return;
      }

      const sealedToken = await sealApiToken(token, "jira-api-token");
      // Validate by making a search request through the proxy
      const resp = await fetch("/api/jira/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
        body: JSON.stringify({
          endpoint: "search",
          cloudId,
          email,
          sealed: sealedToken,
          params: { jql: "assignee = currentUser() AND statusCategory != Done", maxResults: 1 },
        }),
      });
      if (!resp.ok) {
        setJiraApiError("Could not connect — check your email and API token.");
        return;
      }
      let siteName: string;
      try { siteName = new URL(siteUrl).hostname.split(".")[0]; } catch { siteName = cloudId; }
      setJiraAuth({
        accessToken: sealedToken,
        sealedRefreshToken: "",
        expiresAt: Number.MAX_SAFE_INTEGER,
        cloudId,
        siteUrl,
        siteName,
        email,
      });
      updateJiraConfig({ enabled: true, cloudId, email, authMethod: "token", siteUrl, siteName });
      setJiraApiEmail("");
      setJiraApiToken("");
      setJiraApiSubdomain("");
      setJiraApiMode(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[jira-connect]", err);
      Sentry.captureException(err, { tags: { source: "jira-api-token-connect" } });
      setJiraApiError(`Connection failed: ${msg}`);
    } finally {
      setJiraApiConnecting(false);
    }
  }

  function handleJiraDisconnect() {
    clearJiraConfigFull();
    // DefaultTab guard: reset to issues if pointing at Jira tab
    if (config.defaultTab === "jiraAssigned") {
      updateConfig({ defaultTab: "issues" });
    }
    if (viewState.lastActiveTab === "jiraAssigned") {
      updateViewState({ lastActiveTab: "issues" });
    }
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

  const tabOptions = createMemo(() => [
    { value: "issues", label: "Issues" },
    { value: "pullRequests", label: "Pull Requests" },
    { value: "actions", label: "GitHub Actions" },
    ...(config.enableTracking ? [{ value: "tracked", label: "Tracked Items" }] : []),
    ...(config.jira?.enabled ? [{ value: "jiraAssigned", label: "Jira" }] : []),
    ...config.customTabs.map((t) => ({ value: t.id, label: t.name })),
  ]);


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
          <SettingRow
            label="CI status refresh"
            labelSuffix={<InfoTooltip content="Targeted refresh for in-flight CI checks and pending PR status. Separate from the full refresh cycle." />}
            description="How often to re-check in-flight CI checks and workflow runs (10-120s)"
          >
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
          </SettingRow>
        </Section>

        {/* Section 4: API Usage */}
        <Section title="API Usage">
          <div class="px-4 py-3 flex flex-col gap-3">
            <Show
              when={usageSnapshot().length > 0}
              fallback={<p class="p-4 text-base-content/50">No API calls tracked yet.</p>}
            >
              <div class="overflow-x-auto">
                <table class="table table-xs">
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th>Pool</th>
                      <th>Usage</th>
                      <th>Last Called</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={usageSnapshot()}>
                      {(record) => (
                        <tr>
                          <td>{SOURCE_LABELS[record.source] ?? record.source}</td>
                          <td>
                            <Show
                              when={record.pool === "graphql"}
                              fallback={<span class="badge badge-xs badge-outline">core</span>}
                            >
                              <span class="badge badge-xs badge-ghost">graphql</span>
                            </Show>
                          </td>
                          <td class="tabular-nums">{record.count.toLocaleString()}</td>
                          <td>{relativeTime(new Date(record.lastCalledAt).toISOString())}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={2} class="font-medium">Total</td>
                      <td class="tabular-nums font-medium">
                        {usageSnapshot().reduce((sum, r) => sum + r.count, 0).toLocaleString()}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Show>
            <div class="flex items-center justify-between flex-wrap gap-2">
              <Show when={getUsageResetAt() != null}>
                <p class="text-xs text-base-content/60">
                  Window resets at {new Date(getUsageResetAt()!).toLocaleTimeString()}
                </p>
              </Show>
              <button
                type="button"
                onClick={() => resetUsageData()}
                class="btn btn-xs btn-ghost"
              >
                Reset usage
              </button>
            </div>
          </div>
        </Section>

        {/* Section 5: GitHub Actions */}
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

        {/* Section 6: Notifications */}
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

        {/* Section 7: Appearance */}
        <Section title="Appearance">
          <div class="px-4 py-2 border-b border-base-300">
            <p class="text-sm font-medium text-base-content mb-2">Theme</p>
            <ThemePicker />
          </div>
          <div class="px-4 py-2 border-b border-base-300">
            <p class="text-sm font-medium text-base-content mb-2">View density</p>
            <DensityPicker />
          </div>
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

        {/* Section 8: Tabs */}
        <Section title="Tabs">
          <SettingRow
            label="Default tab"
            description="Tab shown when opening the dashboard fresh"
          >
            <select
              value={config.defaultTab}
              onChange={(e) => {
                saveWithFeedback({ defaultTab: e.currentTarget.value as Config["defaultTab"] });
              }}
              class="select select-sm"
            >
              {tabOptions().map((opt) => (
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
          <SettingRow
            label="Enable tracked items"
            description="Show a Tracked tab to pin issues and PRs for quick access"
          >
            <input
              type="checkbox"
              role="switch"
              aria-checked={config.enableTracking}
              aria-label="Enable tracked items"
              checked={config.enableTracking}
              onChange={(e) => {
                const val = e.currentTarget.checked;
                saveWithFeedback({
                  enableTracking: val,
                  ...(!val && config.defaultTab === "tracked" ? { defaultTab: "issues" as const } : {}),
                });
                if (!val && viewState.lastActiveTab === "tracked") {
                  updateViewState({ lastActiveTab: "issues" });
                }
              }}
              class="toggle toggle-primary"
            />
          </SettingRow>
        </Section>

        {/* Section 9: Custom Tabs */}
        <Section title="Custom Tabs" description="Create custom views with saved filters and scoping">
          <CustomTabsSection
            availableOrgs={[...new Set(config.selectedRepos.map((r) => r.owner))]}
            availableRepos={config.selectedRepos}
          />
        </Section>

        {/* Section 10: MCP Server Relay */}
        <Section
          title="MCP Server Relay"
          description="Allow a local MCP server to read dashboard data. Enable this if you use Claude Code or another AI client with the GitHub Tracker MCP server."
        >
          <SettingRow label="Enable relay">
            <input
              type="checkbox"
              role="switch"
              aria-checked={config.mcpRelayEnabled}
              aria-label="Enable MCP relay"
              class="toggle toggle-primary"
              checked={config.mcpRelayEnabled}
              onChange={(e) => saveWithFeedback({ mcpRelayEnabled: e.currentTarget.checked })}
            />
          </SettingRow>
          <Show when={config.mcpRelayEnabled}>
            <SettingRow label="Relay status">
              <span
                class={
                  getRelayStatus() === "connected"
                    ? "text-sm text-success"
                    : getRelayStatus() === "connecting"
                      ? "text-sm text-warning"
                      : "text-sm text-base-content/60"
                }
              >
                {getRelayStatus() === "connected"
                  ? "Connected"
                  : getRelayStatus() === "connecting"
                    ? "Connecting..."
                    : "Not connected"}
              </span>
            </SettingRow>
            <SettingRow label="Port">
              <input
                type="number"
                aria-label="MCP relay port"
                class="input input-sm w-24"
                value={config.mcpRelayPort}
                min={1024}
                max={65535}
                onBlur={(e) => {
                  const port = parseInt(e.currentTarget.value, 10);
                  if (port >= 1024 && port <= 65535) {
                    saveWithFeedback({ mcpRelayPort: port });
                  } else {
                    e.currentTarget.value = String(config.mcpRelayPort);
                  }
                }}
              />
            </SettingRow>
          </Show>
        </Section>

        {/* Section 11: Jira Cloud Integration */}
        <Section title="Jira Cloud Integration">
            <Show
              when={isJiraAuthenticated()}
              fallback={
                <div class="flex flex-col gap-3 px-4 py-3">
                  <Show
                    when={!jiraApiMode()}
                    fallback={
                      <div class="flex flex-col gap-3">
                        <p class="text-xs text-base-content/60">
                          Enter your Atlassian email, an{" "}
                          <a
                            href="https://id.atlassian.com/manage-profile/security/api-tokens"
                            target="_blank"
                            rel="noopener noreferrer"
                            class="link link-primary"
                          >
                            API token
                          </a>
                          , and your Jira Cloud ID. Use <strong>Create API token</strong> (not "with
                          scopes") — it inherits your account's access to Jira projects. The token is
                          used read-only and encrypted before storage.
                        </p>
                        <input
                          type="email"
                          placeholder="your@email.com"
                          value={jiraApiEmail()}
                          onInput={(e) => setJiraApiEmail(e.currentTarget.value)}
                          class="input input-sm w-full"
                          aria-label="Atlassian account email"
                        />
                        <input
                          type="password"
                          placeholder="API token"
                          value={jiraApiToken()}
                          onInput={(e) => setJiraApiToken(e.currentTarget.value)}
                          class="input input-sm w-full"
                          aria-label="Atlassian API token"
                        />
                        <div class="flex items-center gap-1">
                          <span class="text-sm text-base-content/60 shrink-0">https://</span>
                          <input
                            type="text"
                            placeholder="yoursite"
                            value={jiraApiSubdomain()}
                            onInput={(e) => setJiraApiSubdomain(e.currentTarget.value)}
                            class="input input-sm w-32"
                            aria-label="Jira site name"
                          />
                          <span class="text-sm text-base-content/60">.atlassian.net</span>
                        </div>
                        <Show when={jiraApiError()}>
                          <p class="text-xs text-error">{jiraApiError()}</p>
                        </Show>
                        <div class="flex gap-2">
                          <button
                            type="button"
                            onClick={() => void handleJiraApiTokenConnect()}
                            disabled={jiraApiConnecting()}
                            class="btn btn-sm btn-primary"
                          >
                            {jiraApiConnecting() ? "Connecting..." : "Connect"}
                          </button>
                          <button
                            type="button"
                            onClick={() => { setJiraApiMode(false); setJiraApiError(null); setJiraApiSubdomain(""); }}
                            class="btn btn-sm btn-ghost"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    }
                  >
                    <p class="text-xs text-base-content/60">
                      Connect your Jira Cloud account to see assigned issues and detect Jira keys in GitHub items.
                    </p>
                    <div class="flex gap-2 flex-wrap">
                      <Show when={jiraEnabled}>
                        <button
                          type="button"
                          onClick={handleJiraOAuthConnect}
                          class="btn btn-sm btn-primary"
                        >
                          Connect with Jira OAuth
                        </button>
                      </Show>
                      <button
                        type="button"
                        onClick={() => setJiraApiMode(true)}
                        aria-expanded={jiraApiMode()}
                        class={jiraEnabled ? "btn btn-sm btn-outline" : "btn btn-sm btn-primary"}
                      >
                        Use API token
                      </button>
                    </div>
                  </Show>
                </div>
              }
            >
              <SettingRow
                label="Connected site"
                description={jiraAuth()?.siteUrl ?? ""}
              >
                <span class="text-sm font-medium">{jiraAuth()?.siteName ?? ""}</span>
              </SettingRow>
              <SettingRow
                label="Auth method"
                description="How this Jira integration authenticates"
              >
                <span class="text-sm">{config.jira?.authMethod === "token" ? "API Token" : "OAuth"}</span>
              </SettingRow>
              <SettingRow
                label="Issue key detection"
                description="Detect Jira issue keys in GitHub issue and PR titles"
              >
                <input
                  type="checkbox"
                  role="switch"
                  aria-checked={config.jira?.issueKeyDetection ?? true}
                  aria-label="Issue key detection"
                  checked={config.jira?.issueKeyDetection ?? true}
                  onChange={(e) => updateJiraConfig({ issueKeyDetection: e.currentTarget.checked })}
                  class="toggle toggle-primary"
                />
              </SettingRow>
              <SettingRow
                label="Expand issue details"
                description="Show custom field pills on Jira issues by default"
              >
                <input
                  type="checkbox"
                  checked={config.jira?.expandIssueDetails ?? false}
                  onChange={(e) => updateJiraConfig({ expandIssueDetails: e.currentTarget.checked })}
                  class="toggle toggle-primary"
                />
              </SettingRow>
              <SettingRow
                label="Custom Fields"
                description={
                  (config.jira?.customFields ?? []).length > 0
                    ? (config.jira?.customFields ?? []).map((f) => f.name).join(", ")
                    : "None configured"
                }
              >
                <button
                  type="button"
                  class="btn btn-sm btn-outline"
                  onClick={() => {
                    setShowFieldPicker((v) => !v);
                    setTimeout(() => { (document.querySelector("[data-picker-search]") as HTMLElement | null)?.focus(); }, 0);
                  }}
                  aria-expanded={showFieldPicker()}
                >
                  Configure fields
                </button>
              </SettingRow>
              <Show when={showFieldPicker() && jiraClient()}>
                <div class="px-4 pb-3">
                  <JiraFieldPicker
                    client={jiraClient()!}
                    selectedFields={config.jira?.customFields ?? []}
                    onSave={(fields) => { updateJiraCustomFields(fields); setShowFieldPicker(false); }}
                    onCancel={() => setShowFieldPicker(false)}
                  />
                </div>
              </Show>
              <SettingRow
                label="Filter Scopes"
                description={
                  (config.jira?.customScopes ?? []).length > 0
                    ? (config.jira?.customScopes ?? []).map((s) => s.name).join(", ")
                    : "None configured"
                }
              >
                <button
                  type="button"
                  class="btn btn-sm btn-outline"
                  onClick={() => {
                    setShowScopePicker((v) => !v);
                    setTimeout(() => { (document.querySelector("[data-picker-search]") as HTMLElement | null)?.focus(); }, 0);
                  }}
                  aria-expanded={showScopePicker()}
                >
                  Configure filter scopes
                </button>
              </SettingRow>
              <Show when={showScopePicker() && jiraClient()}>
                <div class="px-4 pb-3">
                  <JiraScopePicker
                    client={jiraClient()!}
                    selectedScopes={config.jira?.customScopes ?? []}
                    onSave={(scopes) => { updateJiraCustomScopes(scopes); setShowScopePicker(false); }}
                    onCancel={() => setShowScopePicker(false)}
                  />
                </div>
              </Show>
              <SettingRow
                label="Disconnect"
                description="Remove Jira connection and clear stored credentials"
              >
                <button
                  type="button"
                  onClick={handleJiraDisconnect}
                  class="btn btn-sm btn-error btn-outline"
                >
                  Disconnect
                </button>
              </SettingRow>
            </Show>
          </Section>

        {/* Data */}
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

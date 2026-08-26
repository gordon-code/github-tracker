import { createSignal, createMemo, Show, For, onCleanup, onMount } from "solid-js";
import { Select } from "@kobalte/core/select";
import * as Sentry from "@sentry/solid";
import { getRelayStatus } from "../../lib/mcp-relay";
import { useNavigate } from "@solidjs/router";
import { config, setConfig, updateConfig, updateJiraConfig, updateJiraCustomFields, updateJiraCustomScopes, setMonitoredRepo, isActionsBasedTab } from "../../stores/config";
import type { Config, JiraCustomField } from "../../../shared/schemas";
import {
  buildExportPayload,
  parseImportFile,
  buildEncryptedCredentialsSection,
  resolveImportedCredentials,
  commitImportedSettings,
  CredentialsSectionSchema,
} from "../../lib/settings-transfer";
import type { CredentialBundle, CredentialsSection } from "../../lib/settings-transfer";
import { viewState, updateViewState, setTabFilter } from "../../stores/view";
import { clearAuth, jiraAuth, setJiraAuth, clearJiraConfigFull, isJiraAuthenticated, token, setAuthFromPat } from "../../stores/auth";
import type { GitHubUser } from "../../stores/auth";
import { isValidPatFormat } from "../../lib/pat";
import { clearCache } from "../../stores/cache";
import { pushNotification } from "../../lib/errors";
import { buildOrgAccessUrl, buildJiraAuthorizeUrl } from "../../lib/oauth";
import { sealApiToken, unsealCredentialBundle } from "../../lib/proxy";
import { isSafeGitHubUrl, openGitHubUrl } from "../../lib/url";
import { relativeTime, formatScopeSummary } from "../../lib/format";
import { fetchOrgs } from "../../services/api";
import { getClient } from "../../services/github";
import { getUsageSnapshot, getUsageResetAt, resetUsageData, checkAndResetIfExpired, SOURCE_LABELS } from "../../services/api-usage";
import OrgSelector from "../onboarding/OrgSelector";
import RepoSelector from "../onboarding/RepoSelector";
import Section from "./Section";
import SettingsTOC from "./SettingsTOC";
import SettingRow from "./SettingRow";
import ThemePicker from "./ThemePicker";
import DensityPicker from "./DensityPicker";
import TrackedUsersSection from "./TrackedUsersSection";
import CustomTabsSection from "./CustomTabsSection";
import DependencyExclusionModal from "./DependencyExclusionModal";
import { InfoTooltip } from "../shared/Tooltip";
import { createJiraClient } from "../../lib/jira-utils";
import JiraFieldPicker from "./JiraFieldPicker";
import JiraScopePicker from "./JiraScopePicker";
import type { RepoRef } from "../../services/api";

const VALID_JIRA_CLIENT_ID_RE = /^[A-Za-z0-9_-]+$/;

interface NumberSelectOption {
  value: number;
  label: string;
}

interface StringSelectOption {
  value: string;
  label: string;
}

export const SETTINGS_PAGE_SECTION_IDS = [
  "orgs-repos",
  "tracked-users",
  "refresh",
  "api-usage",
  "appearance",
  "tabs",
  "custom-tabs",
  "actions",
  "notifications",
  "mcp-relay",
  "jira",
  "dependencies",
  "data",
] as const;

// Built-in Jira scope values, duplicated from JiraAssignedTab.tsx's BUILTIN_SCOPE_OPTIONS
// (not exported there to avoid a cross-component coupling for 3 literal strings).
const BUILTIN_JIRA_SCOPES = ["assigned", "reported", "watching"];

/**
 * Returns the scope value to fall back to if `activeScope` no longer exists in
 * `scopes` (e.g. the custom scope backing it was just deleted, or Jira was
 * disconnected and `scopes` is empty) — otherwise null. Guards against firing
 * an invalid JQL query with a stale custom scope ID (BUG-008).
 */
export function staleJiraScopeReset(activeScope: string, scopes: JiraCustomField[]): string | null {
  const validScopeIds = new Set([...BUILTIN_JIRA_SCOPES, ...scopes.map((s) => s.id)]);
  return validScopeIds.has(activeScope) ? null : "assigned";
}

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

  // Replace token panel
  const [showReplaceToken, setShowReplaceToken] = createSignal(false);
  const [replacePatInput, setReplacePatInput] = createSignal("");
  const [replacePatError, setReplacePatError] = createSignal<string | null>(null);
  const [replaceSubmitting, setReplaceSubmitting] = createSignal(false);
  let replaceInputRef: HTMLInputElement | undefined;
  let replaceButtonRef: HTMLButtonElement | undefined;
  let replaceAbortCtrl: AbortController | undefined;

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

  const [scrolled, setScrolled] = createSignal(false);
  onMount(() => {
    const onScroll = () => {
      if (document.documentElement.dataset.scrollLock) return;
      const y = window.scrollY;
      if (scrolled() && y < 10) setScrolled(false);
      else if (!scrolled() && y > 50) setScrolled(true);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onCleanup(() => window.removeEventListener("scroll", onScroll));
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

  const dependencyExclusionPool = createMemo(() => {
    const seen = new Map<string, RepoRef>();
    for (const r of [...config.selectedRepos, ...config.upstreamRepos, ...config.monitoredRepos]) {
      seen.set(r.fullName.toLowerCase(), r);
    }
    return [...seen.values()];
  });
  const dependencyExclusionOrgs = createMemo(() =>
    [...new Set(dependencyExclusionPool().map((r) => r.owner))]
  );
  const excludedCounts = createMemo(() => ({
    orgs: (config.dependencies?.excludedOrgs ?? []).length,
    repos: (config.dependencies?.excludedRepos ?? []).length,
  }));

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

  // ── Export settings ────────────────────────────────────────────────────────
  // includeCredentials opts into an encrypted-credentials section (Task 5). On
  // success the one-time code is shown in a modal and the file download is
  // DEFERRED until the user acknowledges — the code is shown only once.
  const [includeCredentials, setIncludeCredentials] = createSignal(false);
  const [exporting, setExporting] = createSignal(false);
  const [exportCode, setExportCode] = createSignal<string | null>(null);
  const [codeCopied, setCodeCopied] = createSignal(false);
  let pendingExportJson: string | null = null;

  function triggerDownload(jsonText: string) {
    const blob = new Blob([jsonText], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "github-tracker-settings.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleExportSettings() {
    if (exporting()) return;
    const payload = buildExportPayload(config);
    if (!includeCredentials()) {
      triggerDownload(JSON.stringify(payload, null, 2));
      return;
    }
    setExporting(true);
    try {
      // buildEncryptedCredentialsSection generates the code, encrypts the bundle
      // with it, THEN seals the ciphertext (encrypt-then-seal). No secret is
      // logged here (SD-002).
      const { sealed, salt, oneTimeCode } = await buildEncryptedCredentialsSection();
      pendingExportJson = JSON.stringify({ ...payload, _credentials: { sealed, salt } }, null, 2);
      setCodeCopied(false);
      setExportCode(oneTimeCode); // opens the modal; download deferred to ack
    } catch {
      // Turnstile rejection / SealError / oversized pre-check — leave the
      // checkbox checked so the user can retry; do NOT download anything.
      pushNotification(
        "settings-export",
        "Couldn't prepare encrypted credentials for export — please try again.",
        "warning"
      );
    } finally {
      setExporting(false);
    }
  }

  async function handleCopyExportCode() {
    const code = exportCode();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCodeCopied(true);
    } catch {
      // clipboard unavailable — user can still select/copy the shown code
    }
  }

  function handleAcknowledgeExportCode() {
    if (pendingExportJson) {
      triggerDownload(pendingExportJson);
      pendingExportJson = null;
    }
    setExportCode(null);
    setCodeCopied(false);
  }

  function handleDismissExportCode() {
    // Dismiss without downloading. The sealed blob held in memory is inert
    // ciphertext without the code; nothing needs cleanup.
    pendingExportJson = null;
    setExportCode(null);
    setCodeCopied(false);
  }

  // ── Import settings (plaintext) ────────────────────────────────────────────
  // pendingImport holds the parsed-and-validated Config awaiting confirmation;
  // non-null doubles as the two-click confirm state (mirrors confirmReset).
  const [pendingImport, setPendingImport] = createSignal<Config | null>(null);
  let importInputRef: HTMLInputElement | undefined;

  // ── Import settings (encrypted credentials, Task 6) ──────────────────────────
  // credImport is set when the selected file has a valid _credentials section.
  const [credImport, setCredImport] = createSignal<{ config: Config; credentials: CredentialsSection } | null>(null);
  const [codeInput, setCodeInput] = createSignal("");
  const [showCode, setShowCode] = createSignal(false);
  const [unsealInFlight, setUnsealInFlight] = createSignal(false);
  const [cachedCiphertext, setCachedCiphertext] = createSignal<string | null>(null);
  const [credError, setCredError] = createSignal<string | null>(null);
  const [credTerminalMsg, setCredTerminalMsg] = createSignal<string | null>(null);
  const [resolvedCred, setResolvedCred] = createSignal<{ bundle: CredentialBundle; identity: GitHubUser } | null>(null);
  const [committing, setCommitting] = createSignal(false);

  function resetCredImport() {
    setCredImport(null);
    setCodeInput("");
    setShowCode(false);
    setUnsealInFlight(false);
    setCachedCiphertext(null);
    setCredError(null);
    setCredTerminalMsg(null);
    setResolvedCred(null);
  }

  async function handleImportFileSelected(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    // Allow re-selecting the same file (change won't fire otherwise).
    try { input.value = ""; } catch { /* ignore if unsupported */ }
    if (!file) return;
    let text: string;
    try {
      // A read rejection (unreadable/binary file) is treated identically to a
      // parse failure below — same notification path, no confirmation shown.
      text = await file.text();
    } catch {
      pushNotification("settings-import", "Could not read that file — choose a valid settings export.", "warning");
      return;
    }
    const result = parseImportFile(text);
    if (!result.ok) {
      pushNotification("settings-import", `Import failed: ${result.errors[0] ?? "invalid settings file"}`, "warning");
      return;
    }
    // Detect an encrypted-credentials section via schema validation (NOT a bare
    // "in" check — a hand-crafted `_credentials: null` would pass that and then
    // throw on dereference). A malformed/null/non-object one falls through to the
    // plaintext-only path.
    const rawCreds =
      result.rawJson && typeof result.rawJson === "object"
        ? (result.rawJson as Record<string, unknown>)._credentials
        : undefined;
    const credSection = CredentialsSectionSchema.safeParse(rawCreds);
    if (credSection.success) {
      resetCredImport();
      setCredImport({ config: result.config, credentials: credSection.data });
      return;
    }
    setPendingImport(result.config);
  }

  function handleConfirmImport() {
    const imported = pendingImport();
    if (!imported) return;
    // Wholesale replace — parseImportFile returns a fully-parsed Config (every
    // top-level key present), so setConfig is safe (NOT updateConfig's partial merge).
    setConfig(imported);
    setPendingImport(null);
    pushNotification("settings-import", "Settings imported", "info");
  }

  function handleCancelImport() {
    setPendingImport(null);
  }

  async function handleCredCodeSubmit() {
    if (unsealInFlight()) return; // in-flight guard: exactly one network unseal
    const ci = credImport();
    if (!ci) return;
    const code = codeInput();
    setCredError(null);

    let ciphertext = cachedCiphertext();
    if (ciphertext === null) {
      // FIRST submission — single-use network unseal (consumes the bundle nonce
      // server-side). Never retried; wrong-code retries run against the cache.
      setUnsealInFlight(true);
      const res = await unsealCredentialBundle(ci.credentials.sealed).finally(() =>
        setUnsealInFlight(false)
      );
      if (!res.ok) {
        if (res.reason === "turnstile") {
          // Client-side Turnstile hiccup BEFORE any request — the single-use
          // nonce was NOT consumed, so this is retryable. Keep the code prompt
          // available (do NOT fall through to the terminal "continue without
          // credentials" screen); surface a retryable inline message (R-101).
          setCredError("Verification failed — please try again.");
          return;
        }
        setCredTerminalMsg(
          res.reason === "expired"
            ? "This export's credentials have expired — re-export from a machine where you're still signed in, or import the settings without credentials."
            : "Couldn't decrypt credentials — check the code and file match."
        );
        return;
      }
      ciphertext = res.ciphertext;
      setCachedCiphertext(ciphertext);
    }

    // Client-side, retryable against the cached ciphertext (no re-unseal).
    const resolved = await resolveImportedCredentials(ciphertext, ci.credentials.salt, code);
    if (!resolved.ok) {
      setCredError(resolved.error);
      return;
    }
    setResolvedCred({ bundle: resolved.bundle, identity: resolved.identity });
  }

  async function handleConfirmCredImport() {
    const ci = credImport();
    const rc = resolvedCred();
    if (!ci || !rc) return;
    setCommitting(true);
    try {
      await commitImportedSettings(rc, ci.config);
      resetCredImport();
      pushNotification("settings-import", "Settings and credentials imported", "info");
    } catch {
      pushNotification("settings-import", "Something went wrong finishing the import — please try again.", "warning");
    } finally {
      setCommitting(false);
    }
  }

  function handleContinueWithoutCredentials() {
    const ci = credImport();
    if (!ci) return;
    setConfig(ci.config);
    resetCredImport();
    pushNotification("settings-import", "Settings imported (credentials skipped)", "info");
  }

  function handleCancelCredImport() {
    resetCredImport();
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

  async function handleReplaceToken() {
    if (replaceSubmitting()) return;
    setReplaceSubmitting(true);
    setReplacePatError(null);
    const trimmedToken = replacePatInput().trim();

    if (trimmedToken === token()) {
      setReplacePatError("This is already your current token");
      setReplaceSubmitting(false);
      return;
    }

    const validation = isValidPatFormat(trimmedToken);
    if (!validation.valid) {
      setReplacePatError(validation.error);
      setReplaceSubmitting(false);
      return;
    }

    replaceAbortCtrl = new AbortController();
    try {
      const resp = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${trimmedToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: replaceAbortCtrl.signal,
      });
      if (!showReplaceToken()) return;
      if (!resp.ok) {
        setReplacePatError(
          resp.status === 401
            ? "Token is invalid — check that you entered it correctly"
            : `GitHub returned ${resp.status} — try again later`
        );
        return;
      }
      const userData = (await resp.json()) as GitHubUser;
      setAuthFromPat(trimmedToken, userData);
      setReplacePatInput("");
      setShowReplaceToken(false);
      replaceButtonRef?.focus();
      pushNotification("pat-replace", "Token replaced successfully", "info");
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      Sentry.captureException(err, { tags: { source: "pat-replace" } });
      setReplacePatError("Network error — please try again");
    } finally {
      setReplaceSubmitting(false);
    }
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
  const [showDependencyExclusionModal, setShowDependencyExclusionModal] = createSignal(false);

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
    // Stale scope guard: clearJiraConfigFull() wipes customScopes, so a tab
    // filter pointing at a custom scope ID would otherwise survive reconnect
    // and fire an invalid JQL query against the new Jira instance (BUG-008).
    const reset = staleJiraScopeReset(viewState.tabFilters.jiraAssigned.scope, []);
    if (reset) setTabFilter("jiraAssigned", "scope", reset);
  }

  // ── Refresh interval options ──────────────────────────────────────────────

  const refreshOptions: NumberSelectOption[] = [
    { value: 60, label: "1 minute" },
    { value: 120, label: "2 minutes" },
    { value: 300, label: "5 minutes (default)" },
    { value: 600, label: "10 minutes" },
    { value: 900, label: "15 minutes" },
    { value: 1800, label: "30 minutes" },
    { value: 0, label: "Off" },
  ];

  const tabOptions = createMemo<StringSelectOption[]>(() => [
    { value: "issues", label: "Issues" },
    { value: "pullRequests", label: "Pull Requests" },
    ...(config.enableActions ? [{ value: "actions", label: "GitHub Actions" }] : []),
    ...(config.enableTracking ? [{ value: "tracked", label: "Tracked Items" }] : []),
    ...(config.dependencies?.enabled ? [{ value: "dependencies", label: "Dependencies" }] : []),
    ...(config.jira?.enabled ? [{ value: "jiraAssigned", label: "Jira" }] : []),
    ...config.customTabs.filter((t) => config.enableActions || t.baseType !== "actions").map((t) => ({ value: t.id, label: t.name })),
  ]);


  const itemsPerPageOptions: NumberSelectOption[] = [
    { value: 10, label: "10" },
    { value: 25, label: "25" },
    { value: 50, label: "50" },
    { value: 100, label: "100" },
  ];

  return (
    <div class="bg-base-200 min-h-screen">
      {/* Page header */}
      <div class="settings-header sticky top-0 z-40 border-b border-base-300 bg-base-100">
        <div class={`mx-auto max-w-5xl px-4 sm:px-6 transition-[padding] duration-200 ${scrolled() ? "py-2" : "py-6"}`}>
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

      <div class="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div class="flex flex-col lg:flex-row gap-6 lg:gap-8">
          <SettingsTOC />
          <div class="settings-content flex-1 min-w-0 flex flex-col gap-6 max-w-3xl">
        {/* ── Data Sources ─────────────────────────────────────────────────── */}
        <p class="text-xs font-semibold uppercase tracking-wider text-base-content/40 px-1">Data Sources</p>
        {/* Section 1: Orgs & Repos */}
        <Section id="orgs-repos" title="Organizations & Repositories">
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
        <Section id="tracked-users" title="Tracked Users">
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
        <Section id="refresh" title="Refresh">
          <SettingRow
            label="Refresh interval"
            description="How often to poll GitHub for new data"
          >
            <Select
              options={refreshOptions}
              optionValue="value"
              optionTextValue="label"
              value={refreshOptions.find((opt) => opt.value === config.refreshInterval) ?? null}
              onChange={(opt) => opt && saveWithFeedback({ refreshInterval: opt.value })}
              itemComponent={(itemProps) => (
                <Select.Item
                  item={itemProps.item}
                  class="px-3 py-2 cursor-pointer hover:bg-base-200 data-[highlighted]:bg-base-200 outline-none"
                >
                  <Select.ItemLabel>{itemProps.item.rawValue.label}</Select.ItemLabel>
                </Select.Item>
              )}
            >
              <Select.Trigger class="select select-sm">
                <Select.Value<NumberSelectOption>>
                  {(state) => state.selectedOption()?.label ?? ""}
                </Select.Value>
              </Select.Trigger>
              <Select.Portal>
                <Select.Content class="bg-base-100 border border-base-300 rounded-lg shadow-lg z-50 py-1">
                  <Select.Listbox />
                </Select.Content>
              </Select.Portal>
            </Select>
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
        <Section id="api-usage" title="API Usage">
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

        {/* ── Display ────────────────────────────────────────────────────── */}
        <p class="text-xs font-semibold uppercase tracking-wider text-base-content/40 px-1">Display</p>
        {/* Section 5: Appearance */}
        <Section id="appearance" title="Appearance">
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
            <Select
              options={itemsPerPageOptions}
              optionValue="value"
              optionTextValue="label"
              value={itemsPerPageOptions.find((opt) => opt.value === config.itemsPerPage) ?? null}
              onChange={(opt) => opt && saveWithFeedback({ itemsPerPage: opt.value })}
              itemComponent={(itemProps) => (
                <Select.Item
                  item={itemProps.item}
                  class="px-3 py-2 cursor-pointer hover:bg-base-200 data-[highlighted]:bg-base-200 outline-none"
                >
                  <Select.ItemLabel>{itemProps.item.rawValue.label}</Select.ItemLabel>
                </Select.Item>
              )}
            >
              <Select.Trigger class="select select-sm">
                <Select.Value<NumberSelectOption>>
                  {(state) => state.selectedOption()?.label ?? ""}
                </Select.Value>
              </Select.Trigger>
              <Select.Portal>
                <Select.Content class="bg-base-100 border border-base-300 rounded-lg shadow-lg z-50 py-1">
                  <Select.Listbox />
                </Select.Content>
              </Select.Portal>
            </Select>
          </SettingRow>
        </Section>

        {/* Section 6: Tabs */}
        <Section id="tabs" title="Tabs">
          <SettingRow
            label="Default tab"
            description="Tab shown when opening the dashboard fresh"
          >
            <Select
              options={tabOptions()}
              optionValue="value"
              optionTextValue="label"
              value={tabOptions().find((opt) => opt.value === config.defaultTab) ?? null}
              onChange={(opt) => opt && saveWithFeedback({ defaultTab: opt.value })}
              itemComponent={(itemProps) => (
                <Select.Item
                  item={itemProps.item}
                  class="px-3 py-2 cursor-pointer hover:bg-base-200 data-[highlighted]:bg-base-200 outline-none"
                >
                  <Select.ItemLabel>{itemProps.item.rawValue.label}</Select.ItemLabel>
                </Select.Item>
              )}
            >
              <Select.Trigger class="select select-sm">
                <Select.Value<StringSelectOption>>
                  {(state) => state.selectedOption()?.label ?? ""}
                </Select.Value>
              </Select.Trigger>
              <Select.Portal>
                <Select.Content class="bg-base-100 border border-base-300 rounded-lg shadow-lg z-50 py-1">
                  <Select.Listbox />
                </Select.Content>
              </Select.Portal>
            </Select>
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

        {/* Section 7: Custom Tabs */}
        <Section id="custom-tabs" title="Custom Tabs" description="Create custom views with saved filters and scoping">
          <CustomTabsSection
            availableOrgs={[...new Set(config.selectedRepos.map((r) => r.owner))]}
            availableRepos={config.selectedRepos}
          />
        </Section>

        {/* ── Integrations ──────────────────────────────────────────────── */}
        <p class="text-xs font-semibold uppercase tracking-wider text-base-content/40 px-1">Integrations</p>
        {/* Section 8: GitHub Actions */}
        <Section id="actions" title="GitHub Actions">
          <SettingRow
            label="Show Actions tab"
            description="Show the Actions tab and track workflow runs. Disable to reduce API usage and simplify the dashboard."
          >
            <input
              type="checkbox"
              role="switch"
              aria-checked={config.enableActions}
              aria-label="Show Actions tab"
              checked={config.enableActions}
              onChange={(e) => {
                const val = e.currentTarget.checked;
                const needsDefaultReset = !val && isActionsBasedTab(config.defaultTab, config.customTabs);
                const needsLastTabReset = !val && isActionsBasedTab(viewState.lastActiveTab, config.customTabs);
                saveWithFeedback({
                  enableActions: val,
                  ...(needsDefaultReset ? { defaultTab: "issues" as const } : {}),
                  ...(!val ? { notifications: { ...config.notifications, workflowRuns: false } } : {}),
                });
                if (needsLastTabReset) {
                  updateViewState({ lastActiveTab: "issues" });
                }
              }}
              class="toggle toggle-primary"
            />
          </SettingRow>
          <SettingRow
            label="Max workflows per repo"
            description="Number of active workflows to track per repository (1–20)"
          >
            <input
              type="number"
              min={1}
              max={20}
              value={config.maxWorkflowsPerRepo}
              disabled={!config.enableActions}
              onInput={(e) => {
                const val = parseInt(e.currentTarget.value, 10);
                if (!isNaN(val) && val >= 1 && val <= 20) {
                  saveWithFeedback({ maxWorkflowsPerRepo: val });
                }
              }}
              class={`input input-sm w-20${!config.enableActions ? " opacity-50" : ""}`}
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
              disabled={!config.enableActions}
              onInput={(e) => {
                const val = parseInt(e.currentTarget.value, 10);
                if (!isNaN(val) && val >= 1 && val <= 10) {
                  saveWithFeedback({ maxRunsPerWorkflow: val });
                }
              }}
              class={`input input-sm w-20${!config.enableActions ? " opacity-50" : ""}`}
            />
          </SettingRow>
        </Section>

        {/* Section 9: Notifications */}
        <Section id="notifications" title="Notifications">
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
          <SettingRow
            label="Workflow Runs"
            description={!config.enableActions ? "Disabled — GitHub Actions is off" : "Notify when workflow runs complete"}
          >
            <input
              type="checkbox"
              role="switch"
              aria-checked={config.notifications.workflowRuns}
              aria-label="Workflow runs notifications"
              checked={config.notifications.workflowRuns}
              disabled={!config.notifications.enabled || !config.enableActions}
              onChange={(e) =>
                saveWithFeedback({
                  notifications: { ...config.notifications, workflowRuns: e.currentTarget.checked },
                })
              }
              class="toggle toggle-primary"
            />
          </SettingRow>
        </Section>

        {/* Section 10: MCP Server Relay */}
        <Section
          id="mcp-relay"
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
        <Section id="jira" title="Jira Cloud Integration">
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
                    onSave={(scopes) => {
                      updateJiraCustomScopes(scopes);
                      setShowScopePicker(false);
                      // Stale scope guard: if the active Jira tab filter pointed at a
                      // custom scope that was just removed, reset it before it can fire
                      // an invalid JQL query (BUG-008).
                      const reset = staleJiraScopeReset(viewState.tabFilters.jiraAssigned.scope, scopes);
                      if (reset) setTabFilter("jiraAssigned", "scope", reset);
                    }}
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

        {/* Section 12: Dependencies */}
        <Section id="dependencies" title="Dependencies">
          <SettingRow
            label="Dependencies tab"
            description="Auto-show a Dependencies tab when dependency bot PRs are detected"
          >
            <input
              type="checkbox"
              class="toggle toggle-primary"
              aria-label="Enable dependencies tab"
              checked={config.dependencies?.enabled ?? true}
              onChange={() => {
                const val = !(config.dependencies?.enabled ?? true);
                saveWithFeedback({
                  dependencies: { ...config.dependencies, enabled: val },
                  ...(!val && config.defaultTab === "dependencies" ? { defaultTab: "issues" as const } : {}),
                });
                if (!val && viewState.lastActiveTab === "dependencies") {
                  updateViewState({ lastActiveTab: "issues" });
                }
              }}
            />
          </SettingRow>
          <SettingRow
            label="Rebase label"
            description="Label name Renovate uses to signal a PR needs rebasing"
          >
            <input
              type="text"
              class="input input-sm w-40"
              aria-label="Rebase label"
              value={config.dependencies?.rebaseLabel ?? "rebase"}
              maxLength={50}
              placeholder="rebase"
              onInput={(e) => saveWithFeedback({ dependencies: { ...config.dependencies, rebaseLabel: e.currentTarget.value || "rebase" } })}
            />
          </SettingRow>
          <SettingRow
            label="Excluded repos/orgs"
            description="Hide specific repos or entire orgs from the Dependencies tab only — their dependency-bot PRs won't reappear in Pull Requests, but regular issues, pull requests, and workflow runs for those repos are unaffected"
          >
            <div class="flex items-center gap-3">
              <span class="text-xs text-base-content/60">
                {excludedCounts().orgs === 0 && excludedCounts().repos === 0
                  ? "None excluded"
                  : formatScopeSummary(excludedCounts().orgs, excludedCounts().repos, true)}
              </span>
              <button
                type="button"
                class="btn btn-sm btn-outline"
                onClick={() => setShowDependencyExclusionModal(true)}
              >
                Manage
              </button>
            </div>
          </SettingRow>
        </Section>

        {/* ── Account ─────────────────────────────────────────────────── */}
        <p class="text-xs font-semibold uppercase tracking-wider text-base-content/40 px-1">Account</p>
        {/* Section 13: Data */}
        <Section id="data" title="Data">
          {/* Authentication method */}
          <SettingRow
            label="Authentication"
            description={config.authMethod === "pat" ? "Signed in with Personal Access Token" : "Signed in with OAuth"}
          >
            <div class="flex items-center gap-2">
              <span class="text-sm">{config.authMethod === "pat" ? "Personal Access Token" : "OAuth"}</span>
              <Show when={config.authMethod === "pat"}>
                <button
                  ref={replaceButtonRef}
                  type="button"
                  onClick={() => {
                    const opening = !showReplaceToken();
                    setShowReplaceToken(opening);
                    if (opening) {
                      setTimeout(() => replaceInputRef?.focus(), 0);
                    } else {
                      replaceAbortCtrl?.abort();
                      setReplacePatInput(""); setReplacePatError(null);
                    }
                  }}
                  class="btn btn-xs btn-outline"
                  aria-expanded={showReplaceToken()}
                  aria-controls="replace-token-panel"
                >
                  Replace
                </button>
              </Show>
            </div>
          </SettingRow>
          <Show when={showReplaceToken()}>
            <div id="replace-token-panel" class="px-4 py-3 flex flex-col gap-2">
              <form onSubmit={(e) => { e.preventDefault(); void handleReplaceToken(); }}>
                <div class="flex flex-col gap-2">
                  <input
                    ref={replaceInputRef}
                    type="password"
                    autocomplete="new-password"
                    placeholder="ghp_... or github_pat_..."
                    class={`input input-sm w-full${replacePatError() ? " input-error" : ""}`}
                    aria-label="New personal access token"
                    aria-invalid={!!replacePatError()}
                    aria-describedby={replacePatError() ? "replace-pat-error" : undefined}
                    value={replacePatInput()}
                    onInput={(e) => setReplacePatInput(e.currentTarget.value)}
                  />
                  <Show when={replacePatError()}>
                    <p id="replace-pat-error" role="alert" class="text-error text-xs">{replacePatError()}</p>
                  </Show>
                  <div class="flex gap-2">
                    <button
                      type="submit"
                      disabled={replaceSubmitting()}
                      aria-busy={replaceSubmitting()}
                      class="btn btn-sm btn-primary"
                    >
                      {replaceSubmitting() ? "Validating..." : "Replace token"}
                    </button>
                    <button
                      type="button"
                      onClick={() => { replaceAbortCtrl?.abort(); setShowReplaceToken(false); setReplacePatInput(""); setReplacePatError(null); replaceButtonRef?.focus(); }}
                      class="btn btn-sm btn-ghost"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </Show>

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
            <div class="flex flex-col items-end gap-2">
              <label class="flex items-center gap-2 text-xs text-base-content/70 cursor-pointer">
                <input
                  type="checkbox"
                  class="checkbox checkbox-xs"
                  aria-label="Include encrypted credentials for migration"
                  checked={includeCredentials()}
                  onChange={(e) => setIncludeCredentials(e.currentTarget.checked)}
                />
                Include encrypted credentials for migration
              </label>
              <button
                type="button"
                onClick={() => void handleExportSettings()}
                disabled={exporting()}
                aria-busy={exporting()}
                class="btn btn-sm btn-outline"
              >
                {exporting() ? "Preparing..." : "Export"}
              </button>
            </div>
          </SettingRow>

          {/* Import settings */}
          <SettingRow
            label="Import settings"
            description="Replace your configuration from a previously exported JSON file"
          >
            <Show
              when={pendingImport()}
              fallback={
                <Show when={!credImport()}>
                  <input
                    ref={importInputRef}
                    type="file"
                    accept="application/json,.json"
                    class="hidden"
                    aria-label="Import settings file"
                    onChange={(e) => void handleImportFileSelected(e)}
                  />
                  <button
                    type="button"
                    onClick={() => importInputRef?.click()}
                    class="btn btn-sm btn-outline"
                  >
                    Import
                  </button>
                </Show>
              }
            >
              <div class="flex items-center gap-2">
                <span class="text-xs text-base-content/60">This will replace your current settings — continue?</span>
                <button
                  type="button"
                  onClick={handleConfirmImport}
                  class="btn btn-warning btn-xs"
                >
                  Yes, import
                </button>
                <button
                  type="button"
                  onClick={handleCancelImport}
                  class="btn btn-ghost btn-xs"
                >
                  Cancel
                </button>
              </div>
            </Show>
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
          </div>
        </div>

        <DependencyExclusionModal
          open={showDependencyExclusionModal()}
          onClose={() => setShowDependencyExclusionModal(false)}
          availableOrgs={dependencyExclusionOrgs()}
          availableRepos={dependencyExclusionPool()}
          excludedOrgs={config.dependencies?.excludedOrgs ?? []}
          excludedRepos={config.dependencies?.excludedRepos ?? []}
          onSave={(orgs, repos) =>
            saveWithFeedback({ dependencies: { ...config.dependencies, excludedOrgs: orgs, excludedRepos: repos } })
          }
        />

        {/* One-time-code modal (encrypted export). Download is deferred until ack. */}
        <Show when={exportCode()}>
          {(code) => (
            <div
              class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
              role="dialog"
              aria-modal="true"
              aria-label="Save your one-time code"
            >
              <div class="card bg-base-100 shadow-xl max-w-md w-full p-6 flex flex-col gap-4">
                <h3 class="text-lg font-semibold">Save your one-time code</h3>
                <p class="text-sm text-base-content/70">
                  Save this code separately from the export file — you'll need both to restore
                  credentials, and it's shown only once.
                </p>
                <div class="flex items-center gap-2">
                  <code class="flex-1 select-all rounded bg-base-200 px-3 py-2 font-mono text-sm break-all">
                    {code()}
                  </code>
                  <button
                    type="button"
                    onClick={() => void handleCopyExportCode()}
                    class="btn btn-sm btn-outline"
                  >
                    {codeCopied() ? "Copied" : "Copy"}
                  </button>
                </div>
                <div class="flex justify-end gap-2">
                  <button type="button" onClick={handleDismissExportCode} class="btn btn-sm btn-ghost">
                    Cancel
                  </button>
                  <button type="button" onClick={handleAcknowledgeExportCode} class="btn btn-sm btn-primary">
                    I've saved my code — download
                  </button>
                </div>
              </div>
            </div>
          )}
        </Show>

        {/* Encrypted-credentials import dialog: one-time-code entry → identity confirm. */}
        <Show when={credImport()}>
          <div
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            role="dialog"
            aria-modal="true"
            aria-label="Import encrypted credentials"
          >
            <div class="card bg-base-100 shadow-xl max-w-md w-full p-6 flex flex-col gap-4">
              <Show
                when={resolvedCred()}
                fallback={
                  <Show
                    when={!credTerminalMsg()}
                    fallback={
                      <>
                        <h3 class="text-lg font-semibold">Credentials unavailable</h3>
                        <p class="text-sm text-error">{credTerminalMsg()}</p>
                        <div class="flex justify-end gap-2">
                          <button type="button" onClick={handleCancelCredImport} class="btn btn-sm btn-ghost">
                            Cancel
                          </button>
                          <button type="button" onClick={handleContinueWithoutCredentials} class="btn btn-sm btn-primary">
                            Continue without credentials
                          </button>
                        </div>
                      </>
                    }
                  >
                    <h3 class="text-lg font-semibold">Restore encrypted credentials</h3>
                    <p class="text-sm text-base-content/70">
                      Enter the one-time code shown when this file was exported.
                    </p>
                    <form onSubmit={(e) => { e.preventDefault(); void handleCredCodeSubmit(); }}>
                      <div class="flex items-center gap-2">
                        <input
                          type={showCode() ? "text" : "password"}
                          class="input input-sm w-full font-mono"
                          aria-label="One-time code"
                          autocomplete="off"
                          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                          value={codeInput()}
                          onInput={(e) => setCodeInput(e.currentTarget.value)}
                        />
                        <button
                          type="button"
                          onClick={() => setShowCode((v) => !v)}
                          class="btn btn-sm btn-ghost"
                          aria-pressed={showCode()}
                        >
                          {showCode() ? "Hide" : "Show"}
                        </button>
                      </div>
                      <Show when={credError()}>
                        <p role="alert" class="text-error text-xs mt-2">{credError()}</p>
                      </Show>
                      <div class="flex justify-end gap-2 mt-4">
                        <button type="button" onClick={handleCancelCredImport} class="btn btn-sm btn-ghost">
                          Cancel
                        </button>
                        <button type="button" onClick={handleContinueWithoutCredentials} class="btn btn-sm btn-outline">
                          Continue without credentials
                        </button>
                        <button
                          type="submit"
                          disabled={unsealInFlight()}
                          aria-busy={unsealInFlight()}
                          class="btn btn-sm btn-primary"
                        >
                          {unsealInFlight() ? "Checking..." : "Submit"}
                        </button>
                      </div>
                    </form>
                  </Show>
                }
              >
                {(rc) => (
                  <>
                    <h3 class="text-lg font-semibold">Confirm identity</h3>
                    <div class="flex items-center gap-3">
                      <img
                        src={rc().identity.avatar_url}
                        alt=""
                        class="h-10 w-10 rounded-full"
                      />
                      <p class="text-sm">
                        This will sign you in as <strong>@{rc().identity.login}</strong> and replace
                        your current settings — continue?
                      </p>
                    </div>
                    <div class="flex justify-end gap-2">
                      <button type="button" onClick={handleCancelCredImport} class="btn btn-sm btn-ghost">
                        Cancel
                      </button>
                      <button type="button" onClick={handleContinueWithoutCredentials} class="btn btn-sm btn-outline">
                        Continue without credentials
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleConfirmCredImport()}
                        disabled={committing()}
                        aria-busy={committing()}
                        class="btn btn-sm btn-primary"
                      >
                        {committing() ? "Importing..." : "Continue"}
                      </button>
                    </div>
                  </>
                )}
              </Show>
            </div>
          </div>
        </Show>

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

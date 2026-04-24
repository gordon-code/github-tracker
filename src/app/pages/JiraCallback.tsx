import { createSignal, onMount, Show, For } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { setJiraAuth } from "../stores/auth";
import { updateJiraConfig } from "../stores/config";
import { JIRA_OAUTH_STATE_KEY } from "../lib/oauth";
import { acquireTurnstileToken } from "../lib/proxy";
import { JiraClient } from "../services/jira-client";
import type { JiraAccessibleResource } from "../../shared/jira-types";
import LoadingSpinner from "../components/shared/LoadingSpinner";

interface JiraTokenResponse {
  access_token: string;
  sealed_refresh_token: string;
  expires_in: number;
}

function JiraSitePicker(props: {
  sites: JiraAccessibleResource[];
  onSelect: (site: JiraAccessibleResource) => void;
}) {
  return (
    <div class="flex flex-col gap-3 w-full">
      <p class="text-sm text-base-content/70 text-center">
        Select the Jira Cloud site to connect:
      </p>
      <ul class="flex flex-col gap-2">
        <For each={props.sites}>
          {(site) => (
            <li>
              <button
                type="button"
                class="btn btn-outline w-full justify-start gap-3"
                onClick={() => props.onSelect(site)}
              >
                <span class="font-medium">{site.name}</span>
                <span class="text-xs text-base-content/50 truncate">{site.url}</span>
              </button>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

export default function JiraCallback() {
  const navigate = useNavigate();
  const [error, setError] = createSignal<string | null>(null);
  const [sites, setSites] = createSignal<JiraAccessibleResource[] | null>(null);
  const [pendingToken, setPendingToken] = createSignal<JiraTokenResponse | null>(null);

  async function completeSiteSelection(site: JiraAccessibleResource, tokenData: JiraTokenResponse) {
    setJiraAuth({
      accessToken: tokenData.access_token,
      sealedRefreshToken: tokenData.sealed_refresh_token,
      expiresAt: Date.now() + tokenData.expires_in * 1000,
      cloudId: site.id,
      siteUrl: site.url,
      siteName: site.name,
    });
    updateJiraConfig({ enabled: true, cloudId: site.id, siteUrl: site.url, siteName: site.name, authMethod: "oauth" });
    navigate("/settings", { replace: true });
  }

  onMount(async () => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const stateFromUrl = params.get("state");

    // Retrieve and immediately clear stored state (single-use CSRF token)
    const storedState = sessionStorage.getItem(JIRA_OAUTH_STATE_KEY);
    sessionStorage.removeItem(JIRA_OAUTH_STATE_KEY);

    if (!stateFromUrl || !storedState || stateFromUrl !== storedState) {
      setError("Invalid OAuth state. Please try connecting Jira again.");
      console.info("[jira] OAuth state mismatch — possible CSRF attempt");
      return;
    }

    if (!code) {
      setError("No authorization code received from Atlassian.");
      return;
    }

    // Acquire Turnstile token before exchange
    let turnstileToken: string;
    try {
      turnstileToken = await acquireTurnstileToken(import.meta.env.VITE_TURNSTILE_SITE_KEY as string ?? "");
    } catch {
      setError("Human verification failed. Please try again.");
      return;
    }

    // Exchange code for tokens via Worker
    let tokenData: JiraTokenResponse;
    try {
      const resp = await fetch("/api/oauth/jira/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-turnstile-response": turnstileToken,
        },
        body: JSON.stringify({ code }),
      });

      if (!resp.ok) {
        setError("Failed to complete Jira sign in. Please try again.");
        console.info("[jira] token exchange failed", resp.status);
        return;
      }

      tokenData = (await resp.json()) as JiraTokenResponse;
      if (!tokenData.access_token || !tokenData.sealed_refresh_token) {
        setError("Failed to complete Jira sign in. Please try again.");
        return;
      }
    } catch {
      setError("A network error occurred. Please try again.");
      return;
    }

    // Site discovery: try direct browser call first, fall back to Worker proxy
    let resources: JiraAccessibleResource[];
    try {
      resources = await JiraClient.getAccessibleResources(tokenData.access_token);
    } catch {
      // CORS fallback: route through Worker endpoint
      try {
        const fallbackResp = await fetch("/api/oauth/jira/resources", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: JSON.stringify({ accessToken: tokenData.access_token }),
        });
        if (!fallbackResp.ok) {
          setError("Failed to discover Jira sites. Please try again.");
          return;
        }
        resources = (await fallbackResp.json()) as JiraAccessibleResource[];
      } catch {
        setError("A network error occurred discovering Jira sites. Please try again.");
        return;
      }
    }

    if (!resources || resources.length === 0) {
      setError("No Jira Cloud sites found. Ensure your Atlassian account has access to at least one Jira site.");
      return;
    }

    if (resources.length === 1) {
      await completeSiteSelection(resources[0], tokenData);
      return;
    }

    // Multiple sites — show picker
    setPendingToken(tokenData);
    setSites(resources);
  });

  return (
    <div class="bg-base-200 min-h-screen flex items-center justify-center">
      <div class="max-w-sm w-full mx-4 text-center">
        <Show when={error()}>
          <div class="card bg-base-100 shadow-md p-8 flex flex-col items-center gap-4">
            <h2 class="text-lg font-semibold">Connection Error</h2>
            <p class="text-error font-medium">{error()}</p>
            <a href="/settings" class="link link-primary text-sm">
              Return to Settings
            </a>
          </div>
        </Show>
        <Show when={sites()}>
          {(resolvedSites) => (
            <div class="card bg-base-100 shadow-md p-8 flex flex-col items-center gap-4">
              <h2 class="text-lg font-semibold">Connect Jira Site</h2>
              <JiraSitePicker
                sites={resolvedSites()}
                onSelect={(site) => {
                  const token = pendingToken();
                  if (token) void completeSiteSelection(site, token);
                }}
              />
            </div>
          )}
        </Show>
        <Show when={!error() && !sites()}>
          <div class="card bg-base-100 shadow-md p-8 flex flex-col items-center gap-4">
            <h2 class="text-lg font-semibold sr-only">Connecting to Jira</h2>
            <LoadingSpinner size="md" label="Connecting Jira..." />
          </div>
        </Show>
      </div>
    </div>
  );
}

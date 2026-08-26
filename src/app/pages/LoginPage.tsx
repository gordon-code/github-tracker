import { createSignal, onMount, Show, Switch, Match } from "solid-js";
import * as Sentry from "@sentry/solid";
import { useNavigate } from "@solidjs/router";
import { setAuthFromPat, type GitHubUser } from "../stores/auth";
import { config } from "../stores/config";
import type { Config } from "../../shared/schemas";
import {
  isValidPatFormat,
  GITHUB_PAT_URL,
  GITHUB_FINE_GRAINED_PAT_URL,
} from "../lib/pat";
import { buildAuthorizeUrl } from "../lib/oauth";
import { unsealCredentialBundle } from "../lib/proxy";
import {
  parseImportFile,
  resolveImportedCredentials,
  commitImportedSettings,
  hasExistingLocalConfig,
  CredentialsSectionSchema,
} from "../lib/settings-transfer";
import type { CredentialBundle, CredentialsSection } from "../lib/settings-transfer";

export default function LoginPage() {
  const navigate = useNavigate();

  onMount(() => {
    // Speculatively prefetch the dashboard chunk while the user is on the
    // login page. By the time they authenticate, the chunk is cached.
    const prefetch = () => {
      import("../components/dashboard/DashboardPage").catch(() => {
        console.warn("[app] Dashboard chunk prefetch failed");
      });
    };
    "requestIdleCallback" in window
      ? requestIdleCallback(prefetch)
      : setTimeout(prefetch, 2000);
  });

  const [showPatForm, setShowPatForm] = createSignal(false);
  const [patInput, setPatInput] = createSignal("");
  const [patError, setPatError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);

  // ── Import from backup (pre-auth, Task 7) ────────────────────────────────────
  // This is a SIBLING entry point to the PAT-form toggle. It has its OWN local
  // error area because patError()'s <p id="pat-error"> lives only inside the
  // PAT-form branch and never renders here; and pushNotification()/ToastContainer
  // only mount inside the authenticated app shell (Header), so a pre-auth toast
  // would be silently invisible — all errors here MUST use this local area.
  const [showImport, setShowImport] = createSignal(false);
  const [importError, setImportError] = createSignal<string | null>(null);
  // Set when the selected file parses AND carries a valid _credentials section.
  const [credImport, setCredImport] = createSignal<{ config: Config; credentials: CredentialsSection } | null>(null);
  const [codeInput, setCodeInput] = createSignal("");
  const [showCode, setShowCode] = createSignal(false);
  const [unsealInFlight, setUnsealInFlight] = createSignal(false);
  const [cachedCiphertext, setCachedCiphertext] = createSignal<string | null>(null);
  // A terminal (non-retryable) message: the single-use bundle is spent
  // (expired/invalid) — the code prompt is withdrawn.
  const [credTerminal, setCredTerminal] = createSignal<string | null>(null);
  const [resolvedCred, setResolvedCred] = createSignal<{ bundle: CredentialBundle; identity: GitHubUser } | null>(null);
  const [importCommitting, setImportCommitting] = createSignal(false);
  let importInputRef: HTMLInputElement | undefined;

  function handleLogin() {
    window.location.href = buildAuthorizeUrl();
  }

  async function handlePatSubmit(e: Event) {
    e.preventDefault();
    if (submitting()) return;
    const validation = isValidPatFormat(patInput());
    if (!validation.valid) {
      setPatError(validation.error);
      return;
    }
    setSubmitting(true);
    setPatError(null);
    const trimmedToken = patInput().trim();
    try {
      const resp = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${trimmedToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!resp.ok) {
        setPatError(
          resp.status === 401
            ? "Token is invalid — check that you entered it correctly"
            : `GitHub returned ${resp.status} — try again later`
        );
        return;
      }
      if (!showPatForm()) return;
      const userData = (await resp.json()) as GitHubUser;
      setAuthFromPat(trimmedToken, userData);
      setPatInput("");
      navigate("/", { replace: true });
    } catch (err) {
      Sentry.captureException(err, { tags: { source: "pat-validation" } });
      setPatError("Network error — please try again");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Import handlers ──────────────────────────────────────────────────────────

  function resetImportState() {
    setCredImport(null);
    setCodeInput("");
    setShowCode(false);
    setUnsealInFlight(false);
    setCachedCiphertext(null);
    setCredTerminal(null);
    setResolvedCred(null);
    setImportError(null);
  }

  function openImport() {
    setShowPatForm(false);
    setPatError(null);
    setPatInput("");
    resetImportState();
    setShowImport(true);
  }

  function closeImport() {
    setShowImport(false);
    resetImportState();
  }

  async function handleImportFileSelected(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    // Allow re-selecting the same file (change won't fire otherwise).
    try { input.value = ""; } catch { /* ignore if unsupported */ }
    if (!file) return;
    resetImportState();
    let text: string;
    try {
      // A read rejection (unreadable/binary file) is treated the same as a parse
      // failure — surfaced in the local error area (never pushNotification).
      text = await file.text();
    } catch {
      setImportError("Could not read that file — choose a valid settings export.");
      return;
    }
    const result = parseImportFile(text);
    if (!result.ok) {
      // Case (a): malformed JSON / oversized / schema-invalid.
      setImportError(`Import failed: ${result.errors[0] ?? "invalid settings file"}`);
      return;
    }
    // Detect a credentials section via schema validation (NOT a bare "in" check —
    // a hand-crafted `_credentials: null` would pass that and then throw on
    // dereference). A malformed/null/non-object one is treated as case (b).
    const rawCreds =
      result.rawJson && typeof result.rawJson === "object"
        ? (result.rawJson as Record<string, unknown>)._credentials
        : undefined;
    const credSection = CredentialsSectionSchema.safeParse(rawCreds);
    if (!credSection.success) {
      // Case (b): a valid export with NO credentials — the Login page can only
      // auto-login from a credentials-bearing file. Point the user at the normal
      // sign-in + Settings-page import path.
      setImportError(
        "This export doesn't contain credentials — sign in normally first, then use Import on the Settings page to restore your configuration."
      );
      return;
    }
    // Case (c): valid _credentials — prompt for the one-time code (Step 3).
    setCredImport({ config: result.config, credentials: credSection.data });
  }

  async function finalizeImport(bundle: CredentialBundle, identity: GitHubUser, importedConfig: Config) {
    if (importCommitting()) return;
    setImportCommitting(true);
    try {
      // commitImportedSettings awaits clearIdentityData() first when user() is
      // null (pre-auth) — clearing a prior identity's IndexedDB cache + poll
      // state BEFORE the imported identity/config are established.
      await commitImportedSettings({ bundle, identity }, importedConfig);
      navigate("/", { replace: true });
    } catch {
      setImportError("Something went wrong finishing the import — please try again.");
    } finally {
      setImportCommitting(false);
    }
  }

  async function handleImportCodeSubmit(e?: Event) {
    e?.preventDefault();
    if (unsealInFlight()) return; // in-flight guard: exactly one network unseal
    const ci = credImport();
    if (!ci) return;
    const code = codeInput();
    setImportError(null);

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
          // Client-side Turnstile hiccup BEFORE any request — the nonce was NOT
          // consumed, so this is retryable. Keep the code prompt available and
          // show a retryable inline message (R-101).
          setImportError("Verification failed — please try again.");
          return;
        }
        // expired/invalid are terminal — the single-use bundle is spent. Show the
        // message and withdraw the code prompt (re-export to retry).
        setCredTerminal(
          res.reason === "expired"
            ? "This export's credentials have expired — re-export from a machine where you're still signed in, then try again."
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
      setImportError(resolved.error);
      return;
    }

    if (hasExistingLocalConfig(config)) {
      // Prior local state to protect — confirm the identity switch first.
      setResolvedCred({ bundle: resolved.bundle, identity: resolved.identity });
      return;
    }
    // Genuinely fresh/incognito session — skip the dialog, commit straight through.
    await finalizeImport(resolved.bundle, resolved.identity, ci.config);
  }

  async function handleConfirmImport() {
    const ci = credImport();
    const rc = resolvedCred();
    if (!ci || !rc) return;
    await finalizeImport(rc.bundle, rc.identity, ci.config);
  }

  return (
    <div class="bg-base-200 min-h-screen flex items-center justify-center">
      <div class="card bg-base-100 shadow-xl max-w-sm w-full mx-4">
        <div class="card-body items-center text-center gap-6">

          <Switch
            fallback={
              <>
                <div class="flex flex-col items-center gap-2">
                  <h1 class="card-title text-2xl">
                    GitHub Tracker
                  </h1>
                  <p class="text-sm text-base-content/60 text-center">
                    Track issues, pull requests, and workflow runs across your GitHub
                    repositories.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleLogin}
                  class="btn btn-neutral w-full"
                >
                  <svg
                    viewBox="0 0 16 16"
                    class="w-5 h-5"
                    aria-hidden="true"
                    fill="currentColor"
                  >
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                  </svg>
                  Sign in with GitHub
                </button>

                <div class="divider text-xs text-base-content/40">or</div>
                <button
                  type="button"
                  onClick={() => setShowPatForm(true)}
                  class="link link-primary text-sm"
                >
                  Use a Personal Access Token
                </button>
                <button
                  type="button"
                  onClick={openImport}
                  class="link link-primary text-sm"
                >
                  Import from backup
                </button>
              </>
            }
          >
            <Match when={showPatForm()}>
              <form onSubmit={(e) => void handlePatSubmit(e)} class="w-full flex flex-col gap-4">
                <h2 class="card-title">Sign in with Token</h2>

                <div class="text-left w-full">
                  <label for="pat-input" class="label">
                    <span class="label-text">Personal access token</span>
                  </label>
                  <input
                    id="pat-input"
                    type="password"
                    autocomplete="new-password"
                    placeholder="ghp_... or github_pat_..."
                    class={`input input-bordered w-full${patError() !== null ? " input-error" : ""}`}
                    aria-invalid={patError() !== null}
                    aria-describedby={patError() !== null ? "pat-error" : undefined}
                    value={patInput()}
                    onInput={(e) => setPatInput(e.currentTarget.value)}
                  />
                  <Show when={patError() !== null}>
                    <p id="pat-error" role="alert" class="text-error text-xs mt-1">
                      {patError()}
                    </p>
                  </Show>
                </div>

                <button
                  type="submit"
                  class="btn btn-neutral w-full"
                  disabled={submitting()}
                >
                  {submitting() ? "Verifying..." : "Sign in"}
                </button>

                <div class="text-left text-xs space-y-3 mt-4">
                  <div>
                    <p class="font-medium mb-1">
                      <a
                        href={GITHUB_PAT_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="link link-primary"
                      >
                        Classic token
                      </a>
                      {" "}(recommended) — works across all orgs. Select these scopes:
                    </p>
                    <ul class="list-disc list-inside space-y-0.5 text-base-content/70">
                      <li><code>repo</code></li>
                      <li><code>read:org</code> <span class="text-base-content/40">(under admin:org)</span></li>
                    </ul>
                  </div>

                  <p class="text-base-content/50">
                    <a
                      href={GITHUB_FINE_GRAINED_PAT_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="link"
                    >
                      Fine-grained tokens
                    </a>
                    {" "}also work, but only access one org at a time. Add read-only permissions for Actions, Contents, Issues, and Pull requests.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => { setShowPatForm(false); setPatError(null); setPatInput(""); }}
                  class="link link-primary text-sm mt-2"
                >
                  Use OAuth instead
                </button>
              </form>
            </Match>

            <Match when={showImport()}>
              <div class="w-full flex flex-col gap-4">
                <h2 class="card-title">Import from backup</h2>

                <Switch
                  fallback={
                    <>
                      <p class="text-sm text-base-content/70 text-left">
                        Restore your settings and sign in from a previously exported backup file.
                      </p>
                      <input
                        ref={importInputRef}
                        type="file"
                        accept="application/json,.json"
                        class="hidden"
                        aria-label="Import backup file"
                        onChange={(e) => void handleImportFileSelected(e)}
                      />
                      <button
                        type="button"
                        onClick={() => importInputRef?.click()}
                        class="btn btn-neutral w-full"
                      >
                        Choose backup file
                      </button>
                      <Show when={importError()}>
                        <p role="alert" class="text-error text-xs text-left">{importError()}</p>
                      </Show>
                      <button
                        type="button"
                        onClick={closeImport}
                        class="link link-primary text-sm"
                      >
                        Back to sign in
                      </button>
                    </>
                  }
                >
                  <Match when={resolvedCred()}>
                    {(rc) => (
                      <div class="flex flex-col gap-4">
                        <div class="flex items-center gap-3 text-left">
                          <img
                            src={rc().identity.avatar_url}
                            alt=""
                            class="h-10 w-10 rounded-full"
                          />
                          <p class="text-sm">
                            This will sign you in as <strong>@{rc().identity.login}</strong> and
                            replace your current settings — continue?
                          </p>
                        </div>
                        <div class="flex gap-2">
                          <button
                            type="button"
                            onClick={() => void handleConfirmImport()}
                            disabled={importCommitting()}
                            aria-busy={importCommitting()}
                            class="btn btn-sm btn-primary flex-1"
                          >
                            {importCommitting() ? "Importing..." : "Continue"}
                          </button>
                          <button type="button" onClick={closeImport} class="btn btn-sm btn-ghost">
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </Match>

                  <Match when={credImport()}>
                    <Show
                      when={!credTerminal()}
                      fallback={
                        <div class="flex flex-col gap-4">
                          <p role="alert" class="text-error text-xs text-left">{credTerminal()}</p>
                          <button type="button" onClick={closeImport} class="btn btn-sm btn-neutral">
                            Back to sign in
                          </button>
                        </div>
                      }
                    >
                      <form onSubmit={(e) => void handleImportCodeSubmit(e)} class="flex flex-col gap-4">
                        <p class="text-sm text-base-content/70 text-left">
                          Enter the one-time code shown when this file was exported.
                        </p>
                        <div class="flex items-center gap-2">
                          <input
                            type={showCode() ? "text" : "password"}
                            class="input input-bordered input-sm w-full font-mono"
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
                        <Show when={importError()}>
                          <p role="alert" class="text-error text-xs text-left">{importError()}</p>
                        </Show>
                        <div class="flex gap-2">
                          <button
                            type="submit"
                            disabled={unsealInFlight()}
                            aria-busy={unsealInFlight()}
                            class="btn btn-sm btn-primary flex-1"
                          >
                            {unsealInFlight() ? "Checking..." : "Restore credentials"}
                          </button>
                          <button type="button" onClick={closeImport} class="btn btn-sm btn-ghost">
                            Cancel
                          </button>
                        </div>
                      </form>
                    </Show>
                  </Match>
                </Switch>
              </div>
            </Match>
          </Switch>

        </div>
      </div>
    </div>
  );
}

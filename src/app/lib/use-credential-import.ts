import { createSignal } from "solid-js";
import type { Config } from "../../shared/schemas";
import type { GitHubUser } from "../stores/auth";
import { parseImportFile, resolveImportedCredentials, CredentialsSectionSchema } from "./settings-transfer";
import type { CredentialBundle, CredentialsSection } from "./settings-transfer";
import { unsealCredentialBundle } from "./proxy";

const READ_ERROR_MESSAGE = "Could not read that file — choose a valid settings export.";
const DECRYPT_FAILED_MESSAGE =
  "Couldn't restore credentials — this file may already have been used (single-use), or the code/file don't match. Re-export to try again.";

export interface ResolvedCredential {
  bundle: CredentialBundle;
  identity: GitHubUser;
}

export interface CreateCredentialImportOptions {
  /** Terminal message shown when the single-use bundle has expired. Wording
   *  differs slightly between the pre-auth (Login) and post-auth (Settings)
   *  surfaces, so each caller supplies its own copy. */
  expiredMessage: string;
  /** The selected file could not be read (unreadable/binary file). */
  onReadError: (message: string) => void;
  /** parseImportFile rejected the file (malformed JSON / oversized / schema-invalid). */
  onParseError: (message: string) => void;
  /**
   * The file parsed but carries no valid `_credentials` section.
   * `viewPreferences` is the file's raw (unvalidated) `_viewPreferences`
   * section, if present — pass it straight through to `applyImportedViewState`
   * at whatever point the caller commits `config`; it's total/no-throw so
   * passing `undefined` when absent is safe.
   */
  onNoCredentials: (config: Config, viewPreferences: unknown) => void;
  /**
   * The one-time code resolved successfully against the (possibly cached)
   * ciphertext. `viewPreferences` — see `onNoCredentials` above.
   */
  onResolved: (bundle: CredentialBundle, identity: GitHubUser, config: Config, viewPreferences: unknown) => void;
}

/**
 * Shared state machine behind the encrypted-credentials import flow, used by
 * both the pre-auth Login page and the post-auth Settings page: file
 * selection → detect an encrypted `_credentials` section → one-time-code
 * entry → unseal (single network call) → resolve (retryable against the
 * cached ciphertext). What happens once a credential resolves — show an
 * identity-confirm step, commit immediately, or something else — is caller
 * policy via `onResolved`.
 */
export function createCredentialImport(opts: CreateCredentialImportOptions) {
  const [credImport, setCredImport] = createSignal<{ config: Config; credentials: CredentialsSection; viewPreferences: unknown } | null>(null);
  const [codeInput, setCodeInput] = createSignal("");
  const [showCode, setShowCode] = createSignal(false);
  const [unsealInFlight, setUnsealInFlight] = createSignal(false);
  const [cachedCiphertext, setCachedCiphertext] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [terminalError, setTerminalError] = createSignal<string | null>(null);
  const [resolvedCred, setResolvedCred] = createSignal<ResolvedCredential | null>(null);

  // Generation counter tying an in-flight unseal/resolve to the file that started
  // it (mirrors auth.ts's _crossTabFetchGen). Bumped on every reset and on every
  // new file selection; handleCodeSubmit captures it before each await and bails
  // if it changed, so a Cancel-then-reselect during the multi-second
  // unseal/resolve window can't strand one file's ciphertext/credential into a
  // different file's shared signals.
  let gen = 0;

  function reset() {
    gen++;
    setCredImport(null);
    setCodeInput("");
    setShowCode(false);
    setUnsealInFlight(false);
    setCachedCiphertext(null);
    setError(null);
    setTerminalError(null);
    setResolvedCred(null);
  }

  async function handleFileSelected(file: File) {
    reset();
    let text: string;
    try {
      // A read rejection (unreadable/binary file) is treated identically to a
      // parse failure below — same outcome, no confirmation shown.
      text = await file.text();
    } catch {
      opts.onReadError(READ_ERROR_MESSAGE);
      return;
    }
    const result = parseImportFile(text);
    if (!result.ok) {
      opts.onParseError(`Import failed: ${result.errors[0] ?? "invalid settings file"}`);
      return;
    }
    // Detect an encrypted-credentials section via schema validation (NOT a bare
    // "in" check — a hand-crafted `_credentials: null` would pass that and then
    // throw on dereference). A malformed/null/non-object one falls through to
    // the no-credentials callback.
    const rawFile =
      result.rawJson && typeof result.rawJson === "object"
        ? (result.rawJson as Record<string, unknown>)
        : undefined;
    // Raw (unvalidated) — applyImportedViewState (called by whatever the
    // caller commits config through) validates it, total/no-throw.
    const viewPreferences = rawFile?._viewPreferences;
    const credSection = CredentialsSectionSchema.safeParse(rawFile?._credentials);
    if (!credSection.success) {
      opts.onNoCredentials(result.config, viewPreferences);
      return;
    }
    setCredImport({ config: result.config, credentials: credSection.data, viewPreferences });
  }

  async function handleCodeSubmit() {
    if (unsealInFlight()) return; // in-flight guard: exactly one network unseal
    const cred = credImport();
    if (!cred) return;
    const code = codeInput();
    setError(null);
    const capturedGen = gen; // capture before the first await

    let ciphertext = cachedCiphertext();
    if (ciphertext === null) {
      // FIRST submission — single-use network unseal (consumes the bundle nonce
      // server-side). Never retried; wrong-code retries run against the cache.
      setUnsealInFlight(true);
      const res = await unsealCredentialBundle(cred.credentials.sealed).finally(() =>
        setUnsealInFlight(false)
      );
      // A changed generation means a Cancel-then-reselect started a different
      // file while this await was pending; writing any signal now would strand
      // this file's result into the newly-selected file's state, so stop here.
      if (capturedGen !== gen) return;
      if (!res.ok) {
        if (res.reason === "turnstile" || res.reason === "network" || res.reason === "rate-limited") {
          // Pre-nonce-consumption failure — the single-use nonce was NOT
          // consumed, so this is retryable. Keep the code prompt available (do
          // NOT fall through to the terminal "continue without credentials"
          // screen); surface a retryable inline message.
          setError(
            res.reason === "rate-limited"
              ? "Too many attempts — wait a moment and try again."
              : res.reason === "network"
                ? "Network problem — please try again."
                : "Verification failed — please try again."
          );
          return;
        }
        setTerminalError(res.reason === "expired" ? opts.expiredMessage : DECRYPT_FAILED_MESSAGE);
        return;
      }
      ciphertext = res.ciphertext;
      setCachedCiphertext(ciphertext);
    }

    // Client-side, retryable against the cached ciphertext (no re-unseal).
    const resolved = await resolveImportedCredentials(ciphertext, cred.credentials.salt, code);
    // The resolve await is another window where a Cancel-then-reselect can change
    // the generation (unsealInFlight is false here); discard the result if so.
    if (capturedGen !== gen) return;
    if (!resolved.ok) {
      setError(resolved.error);
      return;
    }
    opts.onResolved(resolved.bundle, resolved.identity, cred.config, cred.viewPreferences);
  }

  return {
    credImport,
    codeInput,
    setCodeInput,
    showCode,
    setShowCode,
    unsealInFlight,
    error,
    terminalError,
    resolvedCred,
    setResolvedCred,
    reset,
    handleFileSelected,
    handleCodeSubmit,
  };
}

export type CredentialImport = ReturnType<typeof createCredentialImport>;

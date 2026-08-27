import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Partial mock: keep the REAL user()/token()/clearIdentityData()/setJiraAuth()
// (the cross-identity test drives the REAL commitImportedSettings through them),
// but replace the identity setters with spies. setAuthFromCredential is a SEPARATE
// spy so the import-commit path's call is observable and ordered.
vi.mock("../../src/app/stores/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/stores/auth")>();
  return {
    ...actual,
    setAuthFromPat: vi.fn(),
    setAuthFromCredential: vi.fn(),
  };
});

// Partial mock: keep CredentialsSectionSchema (the component validates
// `_credentials` with it) + the real commitImportedSettings available to delegate
// to; stub the flow functions per-test.
vi.mock("../../src/app/lib/settings-transfer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/lib/settings-transfer")>();
  return {
    ...actual,
    parseImportFile: vi.fn(),
    resolveImportedCredentials: vi.fn(),
    commitImportedSettings: vi.fn(),
    hasExistingLocalConfig: vi.fn(),
  };
});

vi.mock("../../src/app/lib/proxy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/lib/proxy")>();
  return { ...actual, unsealCredentialBundle: vi.fn() };
});

vi.mock("../../src/app/stores/cache", () => ({
  clearCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@sentry/solid", () => ({
  captureException: vi.fn(),
  withSentryErrorBoundary: vi.fn((c: unknown) => c),
}));

vi.mock("../../src/app/lib/pat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/lib/pat")>();
  return {
    ...actual,
    isValidPatFormat: vi.fn(actual.isValidPatFormat),
  };
});

// Mock lazy-loaded component to prevent real imports during prefetch
vi.mock("../../src/app/components/dashboard/DashboardPage", () => ({
  default: () => null,
}));

// Full router mock — per project convention (SolidJS useNavigate requires Route context;
// partial mocks of @solidjs/router render empty divs)
const mockNavigate = vi.fn();
vi.mock("@solidjs/router", () => ({
  useNavigate: () => mockNavigate,
  MemoryRouter: (props: { children: unknown }) => props.children,
  Route: (props: { component: () => unknown }) => props.component(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import LoginPage from "../../src/app/pages/LoginPage";
import * as authStore from "../../src/app/stores/auth";
import * as patLib from "../../src/app/lib/pat";
import * as settingsTransfer from "../../src/app/lib/settings-transfer";
import * as proxyLib from "../../src/app/lib/proxy";
import * as cacheStore from "../../src/app/stores/cache";
import * as configStore from "../../src/app/stores/config";
import { ConfigSchema } from "../../src/shared/schemas";
import type { CredentialBundle } from "../../src/app/lib/settings-transfer";

// ── Helpers ───────────────────────────────────────────────────────────────────

const githubUser = { login: "testuser", avatar_url: "https://avatars.githubusercontent.com/u/1", name: "Test User" };

function mockFetchOk() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(githubUser),
  }));
}

function mockFetch401() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: false,
    status: 401,
  }));
}

function mockFetch503() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: false,
    status: 503,
  }));
}

function mockFetchNetworkError() {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchOk();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { href: "", origin: "http://localhost" },
  });
  sessionStorage.clear();
  vi.stubEnv("VITE_GITHUB_CLIENT_ID", "test-client-id");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("LoginPage — OAuth view (default)", () => {
  it("shows 'Sign in with GitHub' button", () => {
    render(() => <LoginPage />);
    screen.getByText("Sign in with GitHub");
  });

  it("shows 'Use a Personal Access Token' link", () => {
    render(() => <LoginPage />);
    screen.getByText("Use a Personal Access Token");
  });

  it("shows app title and description", () => {
    render(() => <LoginPage />);
    screen.getByText("GitHub Tracker");
    screen.getByText(/Track issues, pull requests/i);
  });

  it("clicking 'Sign in with GitHub' navigates to OAuth URL", async () => {
    const user = userEvent.setup();
    render(() => <LoginPage />);
    await user.click(screen.getByText("Sign in with GitHub"));
    expect(window.location.href).toContain("https://github.com/login/oauth/authorize");
  });

  it("schedules dashboard chunk prefetch on mount", () => {
    // happy-dom lacks requestIdleCallback, so the setTimeout(prefetch, 2000) fallback fires
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(() => <LoginPage />);

    // The prefetch is scheduled via setTimeout with 2s delay
    const timeoutCalls = vi.getTimerCount();
    expect(timeoutCalls).toBeGreaterThan(0);

    // Advancing the timer triggers the import — resolves to mock, no error
    vi.advanceTimersByTime(2000);

    // No console.warn means the .catch() didn't fire (import succeeded via mock)
    expect(warnSpy).not.toHaveBeenCalledWith("[app] Dashboard chunk prefetch failed");

    vi.useRealTimers();
    warnSpy.mockRestore();
  });
});

describe("LoginPage — PAT form navigation", () => {
  it("clicking 'Use a Personal Access Token' shows PAT form", async () => {
    const user = userEvent.setup();
    render(() => <LoginPage />);
    await user.click(screen.getByText("Use a Personal Access Token"));
    screen.getByText("Sign in with Token");
    screen.getByLabelText("Personal access token");
  });

  it("PAT form shows submit button and token creation links", async () => {
    const user = userEvent.setup();
    render(() => <LoginPage />);
    await user.click(screen.getByText("Use a Personal Access Token"));
    screen.getByRole("button", { name: "Sign in" });
    screen.getByRole("link", { name: /Classic token/i });
    screen.getByRole("link", { name: /Fine-grained tokens/i });
  });

  it("shows classic token as recommended", async () => {
    const user = userEvent.setup();
    render(() => <LoginPage />);
    await user.click(screen.getByText("Use a Personal Access Token"));
    screen.getByText(/recommended/i);
  });

  it("shows fine-grained limitations inline", async () => {
    const user = userEvent.setup();
    render(() => <LoginPage />);
    await user.click(screen.getByText("Use a Personal Access Token"));
    screen.getByText(/only access one org at a time/i);
  });

  it("clicking 'Use OAuth instead' returns to OAuth view and clears state", async () => {
    const user = userEvent.setup();
    render(() => <LoginPage />);
    await user.click(screen.getByText("Use a Personal Access Token"));
    screen.getByText("Sign in with Token");
    await user.type(screen.getByLabelText("Personal access token"), "ghp_test");
    await user.click(screen.getByText("Use OAuth instead"));
    screen.getByText("Sign in with GitHub");
    expect(screen.queryByText("Sign in with Token")).toBeNull();
  });
});

describe("LoginPage — PAT form validation", () => {
  async function openPatForm() {
    const user = userEvent.setup();
    render(() => <LoginPage />);
    await user.click(screen.getByText("Use a Personal Access Token"));
    return user;
  }

  it("shows validation error for invalid token format", async () => {
    vi.mocked(patLib.isValidPatFormat).mockReturnValueOnce({
      valid: false,
      error: "Token should start with ghp_ (classic) or github_pat_ (fine-grained)",
    });
    const user = await openPatForm();
    await user.type(screen.getByLabelText("Personal access token"), "bad-token");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    screen.getByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("should start with ghp_");
  });

  it("shows 'Token is invalid' error on 401 from GitHub", async () => {
    vi.mocked(patLib.isValidPatFormat).mockReturnValueOnce({ valid: true });
    mockFetch401();
    const user = await openPatForm();
    await user.type(screen.getByLabelText("Personal access token"), "ghp_" + "a".repeat(36));
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Token is invalid");
    });
    // Token was never stored — setAuthFromPat should NOT have been called
    expect(authStore.setAuthFromPat).not.toHaveBeenCalled();
  });

  it("shows status-specific error on non-401 HTTP failure", async () => {
    vi.mocked(patLib.isValidPatFormat).mockReturnValueOnce({ valid: true });
    mockFetch503();
    const user = await openPatForm();
    await user.type(screen.getByLabelText("Personal access token"), "ghp_" + "a".repeat(36));
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("503");
    });
    expect(authStore.setAuthFromPat).not.toHaveBeenCalled();
  });

  it("calls setAuthFromPat with token and user data, then navigates", async () => {
    vi.mocked(patLib.isValidPatFormat).mockReturnValueOnce({ valid: true });
    mockFetchOk();
    const user = await openPatForm();
    await user.type(screen.getByLabelText("Personal access token"), "ghp_" + "a".repeat(36));
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true });
    });
    expect(authStore.setAuthFromPat).toHaveBeenCalledWith(
      "ghp_" + "a".repeat(36),
      githubUser,
    );
  });

  it("shows 'Verifying...' and disables button while submitting", async () => {
    vi.mocked(patLib.isValidPatFormat).mockReturnValueOnce({ valid: true });
    let resolveFetch!: (v: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(
      new Promise<Response>((r) => { resolveFetch = r; })
    ));
    const user = await openPatForm();
    await user.type(screen.getByLabelText("Personal access token"), "ghp_" + "a".repeat(36));
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: "Verifying..." });
      expect(btn.hasAttribute("disabled")).toBe(true);
    });
    resolveFetch({ ok: true, status: 200, json: () => Promise.resolve(githubUser) } as Response);
  });

  it("re-enables button after successful submission", async () => {
    vi.mocked(patLib.isValidPatFormat).mockReturnValueOnce({ valid: true });
    mockFetchOk();
    const user = await openPatForm();
    await user.type(screen.getByLabelText("Personal access token"), "ghp_" + "a".repeat(36));
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalled();
    });
    // finally block should have run — button no longer disabled
    const btn = screen.getByRole("button", { name: "Sign in" });
    expect(btn.hasAttribute("disabled")).toBe(false);
  });

  it("shows 'Network error' on fetch failure", async () => {
    vi.mocked(patLib.isValidPatFormat).mockReturnValueOnce({ valid: true });
    mockFetchNetworkError();
    const user = await openPatForm();
    await user.type(screen.getByLabelText("Personal access token"), "ghp_" + "a".repeat(36));
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Network error");
    });
    expect(authStore.setAuthFromPat).not.toHaveBeenCalled();
  });

  it("re-enables button after network error", async () => {
    vi.mocked(patLib.isValidPatFormat).mockReturnValueOnce({ valid: true });
    mockFetchNetworkError();
    const user = await openPatForm();
    await user.type(screen.getByLabelText("Personal access token"), "ghp_" + "a".repeat(36));
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      screen.getByRole("alert");
    });
    const btn = screen.getByRole("button", { name: "Sign in" });
    expect(btn.hasAttribute("disabled")).toBe(false);
  });

  it("does not navigate when user switches to OAuth during validation", async () => {
    vi.mocked(patLib.isValidPatFormat).mockReturnValueOnce({ valid: true });
    let resolveFetch!: (v: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(
      new Promise<Response>((r) => { resolveFetch = r; })
    ));
    const user = await openPatForm();
    await user.type(screen.getByLabelText("Personal access token"), "ghp_" + "a".repeat(36));
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      screen.getByRole("button", { name: "Verifying..." });
    });
    // User switches back to OAuth view while fetch is in-flight
    await user.click(screen.getByText("Use OAuth instead"));
    // Resolve fetch as successful — but user already left
    resolveFetch({ ok: true, status: 200, json: () => Promise.resolve(githubUser) } as Response);
    // Wait for async handler to settle
    await waitFor(() => {
      expect(authStore.setAuthFromPat).not.toHaveBeenCalled();
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

// ── Import from backup (Task 7) ───────────────────────────────────────────────

describe("LoginPage — Import from backup", () => {
  const CODE = "1111-2222-3333-4444-5555-6666-77"; // 26-char Crockford base32, dashed
  const IDENTITY = { login: "newuser", avatar_url: "https://a/new", name: "New User" };
  const BUNDLE: CredentialBundle = { github: { token: "ghp_new", method: "pat" }, jira: null };

  function baseConfig() {
    return ConfigSchema.parse({});
  }

  beforeEach(() => {
    // clearAllMocks (parent beforeEach) only clears CALL history; reset the flow
    // stubs' implementations so a mockReturnValue from one test can't leak.
    vi.mocked(settingsTransfer.parseImportFile).mockReset();
    vi.mocked(settingsTransfer.resolveImportedCredentials).mockReset();
    vi.mocked(settingsTransfer.commitImportedSettings).mockReset();
    vi.mocked(settingsTransfer.hasExistingLocalConfig).mockReset();
    vi.mocked(proxyLib.unsealCredentialBundle).mockReset();
  });

  async function openImport(user: ReturnType<typeof userEvent.setup>) {
    render(() => <LoginPage />);
    await user.click(screen.getByRole("button", { name: "Import from backup" }));
  }

  // Fires the file-input change; parseImportFile is mocked, so the file content
  // itself is irrelevant beyond File.text() resolving.
  function fireFileChange() {
    const input = screen.getByLabelText("Import backup file");
    const file = new File(["{}"], "settings.json", { type: "application/json" });
    fireEvent.change(input, { target: { files: [file] } });
  }

  function mockValidCredsFile() {
    vi.mocked(settingsTransfer.parseImportFile).mockReturnValue({
      ok: true,
      config: baseConfig(),
      rawJson: { _credentials: { sealed: "S", salt: "SA" } },
    });
  }

  // ── Step 2: file detection + local error area ──────────────────────────────

  it("shows a parse-error message in the local error area (never a toast)", async () => {
    vi.mocked(settingsTransfer.parseImportFile).mockReturnValue({
      ok: false,
      errors: ["File is not valid JSON."],
    });
    const user = userEvent.setup();
    await openImport(user);
    fireFileChange();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/not valid JSON/i));
    expect(screen.queryByLabelText("One-time code")).toBeNull();
  });

  it("shows the sign-in-first guidance for a credentials-less export, with no code prompt", async () => {
    vi.mocked(settingsTransfer.parseImportFile).mockReturnValue({
      ok: true,
      config: baseConfig(),
      rawJson: { theme: "dark" },
    });
    const user = userEvent.setup();
    await openImport(user);
    fireFileChange();
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/doesn't contain credentials/i)
    );
    expect(screen.queryByLabelText("One-time code")).toBeNull();
  });

  it("treats a null _credentials as no-credentials (guidance, no TypeError, no code prompt)", async () => {
    vi.mocked(settingsTransfer.parseImportFile).mockReturnValue({
      ok: true,
      config: baseConfig(),
      rawJson: { _credentials: null },
    });
    const user = userEvent.setup();
    await openImport(user);
    fireFileChange();
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/doesn't contain credentials/i)
    );
    expect(screen.queryByLabelText("One-time code")).toBeNull();
  });

  it("renders a password-type one-time-code input for a valid _credentials section", async () => {
    mockValidCredsFile();
    const user = userEvent.setup();
    await openImport(user);
    fireFileChange();
    await waitFor(() => screen.getByLabelText("One-time code"));
    expect((screen.getByLabelText("One-time code") as HTMLInputElement).type).toBe("password");
    // No error surfaced on a clean valid-creds detection.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // ── Step 3: unseal → resolve → conditional confirm → commit → navigate ──────

  it("fresh local config skips the confirmation dialog and navigates directly", async () => {
    mockValidCredsFile();
    vi.mocked(proxyLib.unsealCredentialBundle).mockResolvedValue({ ok: true, ciphertext: "CT" });
    vi.mocked(settingsTransfer.resolveImportedCredentials).mockResolvedValue({ ok: true, bundle: BUNDLE, identity: IDENTITY });
    vi.mocked(settingsTransfer.hasExistingLocalConfig).mockReturnValue(false);
    vi.mocked(settingsTransfer.commitImportedSettings).mockResolvedValue({ jiraRestored: true });

    const user = userEvent.setup();
    await openImport(user);
    fireFileChange();
    await waitFor(() => screen.getByLabelText("One-time code"));
    await user.type(screen.getByLabelText("One-time code"), CODE);
    await user.click(screen.getByRole("button", { name: "Restore credentials" }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true }));
    expect(settingsTransfer.commitImportedSettings).toHaveBeenCalledWith(
      { bundle: BUNDLE, identity: IDENTITY },
      expect.objectContaining({ theme: expect.any(String) }),
      undefined // no _viewPreferences section in this test's mocked file content
    );
    expect(screen.queryByText(/sign you in as/i)).toBeNull();
  });

  it("existing local config shows the identity dialog and navigates only after confirm", async () => {
    mockValidCredsFile();
    vi.mocked(proxyLib.unsealCredentialBundle).mockResolvedValue({ ok: true, ciphertext: "CT" });
    vi.mocked(settingsTransfer.resolveImportedCredentials).mockResolvedValue({ ok: true, bundle: BUNDLE, identity: IDENTITY });
    vi.mocked(settingsTransfer.hasExistingLocalConfig).mockReturnValue(true);
    vi.mocked(settingsTransfer.commitImportedSettings).mockResolvedValue({ jiraRestored: true });

    const user = userEvent.setup();
    await openImport(user);
    fireFileChange();
    await waitFor(() => screen.getByLabelText("One-time code"));
    await user.type(screen.getByLabelText("One-time code"), CODE);
    await user.click(screen.getByRole("button", { name: "Restore credentials" }));

    await waitFor(() => screen.getByText(/sign you in as/i));
    screen.getByText(/@newuser/);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(settingsTransfer.commitImportedSettings).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true }));
    expect(settingsTransfer.commitImportedSettings).toHaveBeenCalled();
  });

  it("a commit failure on the identity-confirm path surfaces an inline error and does not navigate", async () => {
    mockValidCredsFile();
    vi.mocked(proxyLib.unsealCredentialBundle).mockResolvedValue({ ok: true, ciphertext: "CT" });
    vi.mocked(settingsTransfer.resolveImportedCredentials).mockResolvedValue({ ok: true, bundle: BUNDLE, identity: IDENTITY });
    vi.mocked(settingsTransfer.hasExistingLocalConfig).mockReturnValue(true);
    vi.mocked(settingsTransfer.commitImportedSettings).mockRejectedValue(new Error("commit boom"));

    const user = userEvent.setup();
    await openImport(user);
    fireFileChange();
    await waitFor(() => screen.getByLabelText("One-time code"));
    await user.type(screen.getByLabelText("One-time code"), CODE);
    await user.click(screen.getByRole("button", { name: "Restore credentials" }));
    await waitFor(() => screen.getByText(/sign you in as/i));

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => screen.getByText(/something went wrong finishing the import/i));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("declining the identity dialog leaves the page in place — no navigation, no commit", async () => {
    mockValidCredsFile();
    vi.mocked(proxyLib.unsealCredentialBundle).mockResolvedValue({ ok: true, ciphertext: "CT" });
    vi.mocked(settingsTransfer.resolveImportedCredentials).mockResolvedValue({ ok: true, bundle: BUNDLE, identity: IDENTITY });
    vi.mocked(settingsTransfer.hasExistingLocalConfig).mockReturnValue(true);

    const user = userEvent.setup();
    await openImport(user);
    fireFileChange();
    await waitFor(() => screen.getByLabelText("One-time code"));
    await user.type(screen.getByLabelText("One-time code"), CODE);
    await user.click(screen.getByRole("button", { name: "Restore credentials" }));
    await waitFor(() => screen.getByText(/sign you in as/i));

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(settingsTransfer.commitImportedSettings).not.toHaveBeenCalled();
  });

  it("pr-test-2: concurrent double-click on Continue calls commitImportedSettings EXACTLY once (finalizeImport in-flight guard)", async () => {
    mockValidCredsFile();
    vi.mocked(proxyLib.unsealCredentialBundle).mockResolvedValue({ ok: true, ciphertext: "CT" });
    vi.mocked(settingsTransfer.resolveImportedCredentials).mockResolvedValue({ ok: true, bundle: BUNDLE, identity: IDENTITY });
    vi.mocked(settingsTransfer.hasExistingLocalConfig).mockReturnValue(true);
    let resolveCommit!: (v: { jiraRestored: boolean }) => void;
    vi.mocked(settingsTransfer.commitImportedSettings).mockReturnValue(
      new Promise((r) => { resolveCommit = r; })
    );

    const user = userEvent.setup();
    await openImport(user);
    fireFileChange();
    await waitFor(() => screen.getByLabelText("One-time code"));
    await user.type(screen.getByLabelText("One-time code"), CODE);
    await user.click(screen.getByRole("button", { name: "Restore credentials" }));
    await waitFor(() => screen.getByText(/sign you in as/i));

    const continueBtn = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    fireEvent.click(continueBtn);
    continueBtn.disabled = false;
    fireEvent.click(continueBtn);
    resolveCommit({ jiraRestored: true });

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true }));
    expect(settingsTransfer.commitImportedSettings).toHaveBeenCalledTimes(1);
  });

  it("wrong code then correct code: retries against the cached ciphertext, unseals only ONCE", async () => {
    mockValidCredsFile();
    vi.mocked(proxyLib.unsealCredentialBundle).mockResolvedValue({ ok: true, ciphertext: "CT" });
    vi.mocked(settingsTransfer.resolveImportedCredentials)
      .mockResolvedValueOnce({ ok: false, error: "Couldn't decrypt credentials — check the code and file match." })
      .mockResolvedValueOnce({ ok: true, bundle: BUNDLE, identity: IDENTITY });
    vi.mocked(settingsTransfer.hasExistingLocalConfig).mockReturnValue(false);
    vi.mocked(settingsTransfer.commitImportedSettings).mockResolvedValue({ jiraRestored: true });

    const user = userEvent.setup();
    await openImport(user);
    fireFileChange();
    await waitFor(() => screen.getByLabelText("One-time code"));
    const codeField = screen.getByLabelText("One-time code");
    await user.type(codeField, "wrong");
    await user.click(screen.getByRole("button", { name: "Restore credentials" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/check the code and file match/i));
    expect(mockNavigate).not.toHaveBeenCalled();
    screen.getByLabelText("One-time code"); // still available for retry

    await user.clear(codeField);
    await user.type(codeField, CODE);
    await user.click(screen.getByRole("button", { name: "Restore credentials" }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true }));

    expect(proxyLib.unsealCredentialBundle).toHaveBeenCalledTimes(1);
  });

  it("an expired unseal shows the distinct expired message and withdraws the code prompt", async () => {
    mockValidCredsFile();
    vi.mocked(proxyLib.unsealCredentialBundle).mockResolvedValue({ ok: false, reason: "expired" });

    const user = userEvent.setup();
    await openImport(user);
    fireFileChange();
    await waitFor(() => screen.getByLabelText("One-time code"));
    await user.type(screen.getByLabelText("One-time code"), CODE);
    await user.click(screen.getByRole("button", { name: "Restore credentials" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/expired/i));
    expect(screen.queryByLabelText("One-time code")).toBeNull(); // terminal — no retry
    screen.getByRole("button", { name: "Back to sign in" });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("a revoked GitHub credential surfaces the distinct revoked message and keeps the code prompt", async () => {
    mockValidCredsFile();
    vi.mocked(proxyLib.unsealCredentialBundle).mockResolvedValue({ ok: true, ciphertext: "CT" });
    vi.mocked(settingsTransfer.resolveImportedCredentials).mockResolvedValue({
      ok: false,
      error: "Imported GitHub credential is no longer valid — it may have been revoked, or the token/session has expired.",
    });

    const user = userEvent.setup();
    await openImport(user);
    fireFileChange();
    await waitFor(() => screen.getByLabelText("One-time code"));
    await user.type(screen.getByLabelText("One-time code"), CODE);
    await user.click(screen.getByRole("button", { name: "Restore credentials" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/no longer valid|revoked/i));
    screen.getByLabelText("One-time code"); // still available (retryable)
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("R-101: a turnstile failure shows a retryable message, keeps the code prompt, and re-unseals on retry", async () => {
    mockValidCredsFile();
    vi.mocked(proxyLib.unsealCredentialBundle)
      .mockResolvedValueOnce({ ok: false, reason: "turnstile" })
      .mockResolvedValueOnce({ ok: true, ciphertext: "CT" });
    vi.mocked(settingsTransfer.resolveImportedCredentials).mockResolvedValue({ ok: true, bundle: BUNDLE, identity: IDENTITY });
    vi.mocked(settingsTransfer.hasExistingLocalConfig).mockReturnValue(false);
    vi.mocked(settingsTransfer.commitImportedSettings).mockResolvedValue({ jiraRestored: true });

    const user = userEvent.setup();
    await openImport(user);
    fireFileChange();
    await waitFor(() => screen.getByLabelText("One-time code"));
    await user.type(screen.getByLabelText("One-time code"), CODE);
    await user.click(screen.getByRole("button", { name: "Restore credentials" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/verification failed/i));
    screen.getByLabelText("One-time code"); // NON-terminal — retry still possible
    expect(mockNavigate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Restore credentials" }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true }));
    // Re-unsealed (nonce never consumed on the client-side turnstile failure).
    expect(proxyLib.unsealCredentialBundle).toHaveBeenCalledTimes(2);
  });

  // ── Must-have: cross-identity IndexedDB isolation (REAL clearIdentityData) ───

  it("cross-identity: clears the prior identity's IndexedDB cache (real clearIdentityData) BEFORE establishing the imported identity/config", async () => {
    // Delegate to the REAL commitImportedSettings so the pre-auth (user()===null)
    // clearIdentityData ordering actually executes. Auth is partially mocked so
    // user()/clearIdentityData() are real; clearCache is mocked (no real IndexedDB).
    const actualTransfer = await vi.importActual<typeof import("../../src/app/lib/settings-transfer")>(
      "../../src/app/lib/settings-transfer"
    );
    vi.mocked(settingsTransfer.commitImportedSettings).mockImplementation(actualTransfer.commitImportedSettings);

    vi.mocked(settingsTransfer.parseImportFile).mockReturnValue({
      ok: true,
      config: ConfigSchema.parse({}),
      rawJson: { _credentials: { sealed: "S", salt: "SA" } },
    });
    vi.mocked(proxyLib.unsealCredentialBundle).mockResolvedValue({ ok: true, ciphertext: "CT" });
    vi.mocked(settingsTransfer.resolveImportedCredentials).mockResolvedValue({
      ok: true,
      bundle: { github: { token: "ghp_new", method: "pat" }, jira: null },
      identity: IDENTITY,
    });
    vi.mocked(settingsTransfer.hasExistingLocalConfig).mockReturnValue(false); // skip dialog → immediate commit

    const setConfigSpy = vi.spyOn(configStore, "setConfig");

    const user = userEvent.setup();
    await openImport(user);
    fireFileChange();
    await waitFor(() => screen.getByLabelText("One-time code"));
    await user.type(screen.getByLabelText("One-time code"), CODE);
    await user.click(screen.getByRole("button", { name: "Restore credentials" }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true }));

    // clearCache (fired by the REAL clearIdentityData, pre-auth path) ran, and
    // strictly BEFORE the imported identity/config were established.
    expect(cacheStore.clearCache).toHaveBeenCalled();
    expect(authStore.setAuthFromCredential).toHaveBeenCalled();
    const clearOrder = vi.mocked(cacheStore.clearCache).mock.invocationCallOrder[0];
    const authOrder = vi.mocked(authStore.setAuthFromCredential).mock.invocationCallOrder[0];
    const cfgOrder = setConfigSpy.mock.invocationCallOrder[0];
    expect(clearOrder).toBeLessThan(authOrder);
    expect(clearOrder).toBeLessThan(cfgOrder);
  });

  // ── STRUCT-C-001: generation guard + in-flight close lock ───────────────────

  it("STRUCT-C-001: a Cancel during resolve discards the stale continuation — no auto-login/navigation as the abandoned identity", async () => {
    mockValidCredsFile();
    vi.mocked(proxyLib.unsealCredentialBundle).mockResolvedValue({ ok: true, ciphertext: "CT" });
    // Defer the resolve so the flow can be abandoned while it is pending.
    let finishResolve!: (v: { ok: true; bundle: CredentialBundle; identity: typeof IDENTITY }) => void;
    vi.mocked(settingsTransfer.resolveImportedCredentials).mockReturnValueOnce(
      new Promise((r) => { finishResolve = r as never; })
    );
    vi.mocked(settingsTransfer.hasExistingLocalConfig).mockReturnValue(false); // would otherwise auto-login
    vi.mocked(settingsTransfer.commitImportedSettings).mockResolvedValue({ jiraRestored: true });

    const user = userEvent.setup();
    await openImport(user);
    fireFileChange();
    await waitFor(() => screen.getByLabelText("One-time code"));
    await user.type(screen.getByLabelText("One-time code"), CODE);
    await user.click(screen.getByRole("button", { name: "Restore credentials" }));

    // Unseal done (unsealInFlight false), resolve in flight — Cancel is enabled.
    await waitFor(() => expect(proxyLib.unsealCredentialBundle).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Cancel" })); // abandons the flow (gen++)

    // The stale resolve now completes — the generation guard must discard it, so
    // no commit and no auto-login/navigation as the abandoned file's identity.
    finishResolve({ ok: true, bundle: BUNDLE, identity: IDENTITY });
    await Promise.resolve();
    await Promise.resolve();

    expect(settingsTransfer.commitImportedSettings).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("STRUCT-C-001: Cancel is disabled while the unseal is in flight", async () => {
    mockValidCredsFile();
    let resolveUnseal!: (v: { ok: true; ciphertext: string }) => void;
    vi.mocked(proxyLib.unsealCredentialBundle).mockReturnValue(new Promise((r) => { resolveUnseal = r; }));
    vi.mocked(settingsTransfer.resolveImportedCredentials).mockResolvedValue({ ok: true, bundle: BUNDLE, identity: IDENTITY });
    vi.mocked(settingsTransfer.hasExistingLocalConfig).mockReturnValue(false);
    vi.mocked(settingsTransfer.commitImportedSettings).mockResolvedValue({ jiraRestored: true });

    const user = userEvent.setup();
    await openImport(user);
    fireFileChange();
    await waitFor(() => screen.getByLabelText("One-time code"));
    await user.type(screen.getByLabelText("One-time code"), CODE);
    await user.click(screen.getByRole("button", { name: "Restore credentials" }));

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true)
    );
    resolveUnseal({ ok: true, ciphertext: "CT" });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true }));
  });

  it("a retryable network unseal keeps the code prompt (not terminal)", async () => {
    mockValidCredsFile();
    vi.mocked(proxyLib.unsealCredentialBundle).mockResolvedValue({ ok: false, reason: "network" });
    const user = userEvent.setup();
    await openImport(user);
    fireFileChange();
    await waitFor(() => screen.getByLabelText("One-time code"));
    await user.type(screen.getByLabelText("One-time code"), CODE);
    await user.click(screen.getByRole("button", { name: "Restore credentials" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/network problem/i));
    screen.getByLabelText("One-time code"); // NON-terminal — retry still possible
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("a commit failure during finalize surfaces an inline error (finalizeImport catch branch)", async () => {
    mockValidCredsFile();
    vi.mocked(proxyLib.unsealCredentialBundle).mockResolvedValue({ ok: true, ciphertext: "CT" });
    vi.mocked(settingsTransfer.resolveImportedCredentials).mockResolvedValue({ ok: true, bundle: BUNDLE, identity: IDENTITY });
    vi.mocked(settingsTransfer.hasExistingLocalConfig).mockReturnValue(false); // auto-commit path
    vi.mocked(settingsTransfer.commitImportedSettings).mockRejectedValue(new Error("commit boom"));

    const user = userEvent.setup();
    await openImport(user);
    fireFileChange();
    await waitFor(() => screen.getByLabelText("One-time code"));
    await user.type(screen.getByLabelText("One-time code"), CODE);
    await user.click(screen.getByRole("button", { name: "Restore credentials" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/something went wrong/i));
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

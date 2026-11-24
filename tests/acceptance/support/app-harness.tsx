import { vi, expect, type MockInstance } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@solidjs/testing-library";
import App, { _resetAuthInitStartedForTests } from "../../../src/app/App";
import * as pollService from "../../../src/app/services/poll";
import { CONFIG_STORAGE_KEY, resetConfig, updateConfig } from "../../../src/app/stores/config";
import { resetViewState } from "../../../src/app/stores/view";
import { resetNotificationState } from "../../../src/app/lib/errors";
import { resetToastState } from "../../../src/app/components/shared/ToastContainer";
import { checkForUpdate } from "../../../src/app/lib/version";

// Shared helpers for acceptance step files that render the real App. Each step file
// still declares its own vi.mock() calls (they are hoisted per file); everything here
// runs against whatever modules that file mocked.

/**
 * The running build's 12-character SHA, installed with `_setGitShaForTests`. It differs
 * from the Vitest build constant so a scenario fails if the helper did not take effect.
 */
export const RUNNING_SHA = "1234567890ab";
/** A different 12-character SHA standing in for a newer deployment. */
export const DEPLOYED_SHA = "0123456789ab";
export const FOREIGN_SCHEMA_FP = "ffffffffffff";

export const BANNER_TEXT = "A new version is available.";
export const DRAWER_TEXT = "A new version of GitHub Tracker is available — reload to update.";
export const READ_ONLY_SENTENCE =
  "This tab can't save changes, and Settings are read-only, until you reload.";

export const RELEASES_URL = "https://github.com/gordon-code/github-tracker/releases";
export const CHANGELOG_URL = "https://github.com/gordon-code/github-tracker/blob/main/CHANGELOG.md";

/**
 * happy-dom computes `animation-name` as "" rather than a browser's "none", so Kobalte's
 * presence logic waits for an animationend that never comes and a closed dialog stays
 * mounted (with the rest of the page still aria-hidden). This gives it the browser value.
 */
export function installNoAnimationStyle(): void {
  if (document.getElementById("acceptance-no-animations")) return;
  const style = document.createElement("style");
  style.id = "acceptance-no-animations";
  style.textContent = "*, *::before, *::after { animation-name: none; }";
  document.head.append(style);
}

// ── /version.json ─────────────────────────────────────────────────────────────

export type VersionReply =
  | { kind: "json"; body: unknown }
  | { kind: "html" }
  | { kind: "network-error" };

let versionReply: VersionReply = { kind: "network-error" };
let versionRequests = 0;

export function buildInfo(sha: string, extra: Record<string, unknown> = {}) {
  return { version: "9.9.9", sha, builtAt: "2026-11-07T00:00:00.000Z", ...extra };
}

export function serveVersion(reply: VersionReply): void {
  versionReply = reply;
}

export function versionRequestCount(): number {
  return versionRequests;
}

export function resetVersionServer(): void {
  versionReply = { kind: "network-error" };
  versionRequests = 0;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Serves /version.json from `serveVersion` and rejects every other request.
 * tests/fetch-guard.ts re-stubs fetch with a rejecting mock before every test, and
 * vitest-cucumber runs every step as its own test, so a step that can trigger a version
 * check (`switchAwayAndBack` does this itself) installs it again first.
 */
export function installNetwork(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (!url.endsWith("/version.json")) {
        return Promise.reject(new TypeError(`Unexpected request in acceptance test: ${url}`));
      }
      versionRequests++;
      if (versionReply.kind === "network-error") {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      if (versionReply.kind === "html") {
        return Promise.resolve(
          new Response('<!doctype html><html><body><div id="app"></div></body></html>', {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(versionReply.body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
}

/** Switches away from the tab and back, then waits for the check it starts to settle. */
export async function switchAwayAndBack(): Promise<void> {
  installNetwork();
  const before = versionRequests;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(versionRequests).toBe(before + 1);
  // While a check is in flight checkForUpdate() returns it, so this awaits the
  // visibility-triggered check without starting another one.
  await checkForUpdate({ throttled: true });
}

// ── Document navigations ──────────────────────────────────────────────────────

export interface NavigationSpies {
  assign: MockInstance<Location["assign"]>;
  reload: MockInstance<Location["reload"]>;
  replace: MockInstance<Location["replace"]>;
}

/**
 * happy-dom cannot load a new document, so a full navigation is observed at the
 * Location method the app calls for it; nothing else about the navigation changes.
 * Restored by `vi.restoreAllMocks()`.
 */
export function observeDocumentNavigations(): NavigationSpies {
  return {
    assign: vi.spyOn(window.location, "assign").mockImplementation(() => {}),
    reload: vi.spyOn(window.location, "reload").mockImplementation(() => {}),
    replace: vi.spyOn(window.location, "replace").mockImplementation(() => {}),
  };
}

export function expectNoDocumentNavigation(spies: NavigationSpies): void {
  expect(spies.assign).not.toHaveBeenCalled();
  expect(spies.reload).not.toHaveBeenCalled();
  expect(spies.replace).not.toHaveBeenCalled();
}

// ── Services ──────────────────────────────────────────────────────────────────

/** Poll coordinators that run one empty fetch, as the dashboard does on mount. */
export function installEmptyPolling(): void {
  vi.mocked(pollService.fetchAllData).mockResolvedValue({
    issues: [],
    pullRequests: [],
    workflowRuns: [],
    errors: [],
  });
  vi.mocked(pollService.createPollCoordinator).mockImplementation(
    (_getInterval: unknown, fetchAll: () => Promise<unknown>) => {
      void fetchAll().catch(() => {});
      return {
        isRefreshing: () => false,
        lastRefreshAt: () => null,
        manualRefresh: vi.fn(),
        destroy: vi.fn(),
      };
    },
  );
  vi.mocked(pollService.createHotPollCoordinator).mockImplementation(() => ({ destroy: vi.fn() }));
  vi.mocked(pollService.createEventsPollCoordinator).mockImplementation(() => ({ destroy: vi.fn() }));
}

/**
 * Per-scenario reset: clears mocks, storage, notifications and toasts, and leaves a
 * signed-in, onboarded user tracking one repo with empty polling. Version state is not
 * touched here, because vitest-cucumber runs the Background (which sets it) before
 * BeforeEachScenario.
 */
export function resetSignedInApp(): void {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  _resetAuthInitStartedForTests();
  resetNotificationState();
  resetToastState();
  resetVersionServer();
  resetConfig();
  updateConfig({
    onboardingComplete: true,
    selectedOrgs: ["testorg"],
    selectedRepos: [{ owner: "testorg", name: "testrepo", fullName: "testorg/testrepo" }],
  });
  resetViewState();
  installEmptyPolling();
}

// ── Pages ─────────────────────────────────────────────────────────────────────

export function renderAppAt(path: string) {
  window.history.pushState({}, "", path);
  return render(() => <App />);
}

export async function openDashboard(): Promise<void> {
  renderAppAt("/dashboard");
  await screen.findByRole("tablist", {}, { timeout: 5_000 });
}

export async function openSettings(): Promise<void> {
  renderAppAt("/settings");
  await findSettingsHeading();
}

export function findSettingsHeading(): Promise<HTMLElement> {
  return screen.findByRole("heading", { name: /^settings$/i }, { timeout: 5_000 });
}

export function queryBanner(): HTMLElement | null {
  return screen.queryAllByRole("status").find((el) => el.textContent?.includes(BANNER_TEXT)) ?? null;
}

export function getBanner(): HTMLElement {
  const banner = queryBanner();
  if (!banner) throw new Error("Update banner is not shown");
  return banner;
}

export function bellButton(): HTMLElement {
  return screen.getByRole("button", { name: /^Notifications/ });
}

export function whatsNewButton(): HTMLElement {
  return screen.getByRole("button", { name: /^What's new/ });
}

/**
 * Once anything imports the `@kobalte/core` barrel (RepoSelector does), Kobalte's
 * AlertDialog namespace — built with Object.assign on the same DialogRoot function as
 * Dialog — replaces Dialog.Content, so dialogs can render with role="alertdialog".
 */
export function queryDialog(name: string): HTMLElement | null {
  return screen.queryByRole("dialog", { name }) ?? screen.queryByRole("alertdialog", { name });
}

export function findDialog(name: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = queryDialog(name);
    if (!found) throw new Error(`Dialog "${name}" is not open`);
    return found;
  });
}

/**
 * Closes a dialog with its labelled close button and waits for it to unmount.
 * fireEvent is used because an open modal sets pointer-events:none on the body,
 * which user-event honours.
 */
export async function closeDialog(name: string, closeLabel: string): Promise<void> {
  const dialog = await findDialog(name);
  fireEvent.click(within(dialog).getByRole("button", { name: closeLabel }));
  await waitFor(() => {
    expect(queryDialog(name)).toBeNull();
    // Kobalte restores the rest of the page (aria-hidden, pointer-events) after unmounting.
    expect(Array.from(document.body.children).some((el) => el.getAttribute("aria-hidden") === "true")).toBe(false);
  });
}

/** Opens the Notification Drawer, returns its list entries, and closes it again. */
export async function readDrawer(): Promise<{ entries: HTMLElement[]; empty: boolean }> {
  fireEvent.click(bellButton());
  const drawer = await findDialog("Notifications");
  const entries = within(drawer).queryAllByRole("listitem");
  const empty = within(drawer).queryByText("No notifications") !== null;
  await closeDialog("Notifications", "Close notifications");
  return { entries, empty };
}

export async function drawerUpdateEntries(): Promise<HTMLElement[]> {
  const { entries } = await readDrawer();
  return entries.filter((li) => li.textContent?.includes(DRAWER_TEXT));
}

/** Toasts render as role="alert" in the bottom-right stack. */
export function visibleToasts(): HTMLElement[] {
  return screen.queryAllByRole("alert");
}

/** Whether a form control is disabled, including by an ancestor `<fieldset disabled>`. */
export function isDisabled(control: Element): boolean {
  return (
    (control instanceof HTMLButtonElement && control.disabled) ||
    control.closest("fieldset[disabled]") !== null
  );
}

export function storedConfig(): Record<string, unknown> | null {
  const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

/**
 * Waits past the 200 ms persistence debounce so any scheduled write has landed.
 * tests/setup.ts clears pending timers after every test, and vitest-cucumber runs each
 * step as its own test, so a step that changes persisted state calls this before it
 * ends; otherwise the write would be dropped and a later "nothing was saved" check
 * would pass for the wrong reason.
 */
export function waitPastPersistenceDebounce(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 300));
}

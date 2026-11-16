import { vi, expect, afterAll } from "vitest";

// vitest-cucumber maps each Given/When/Then to a separate test(). The DOM must
// persist across steps within a scenario, but @solidjs/testing-library registers
// afterEach(cleanup) at import time — vi.hoisted ensures the env var is set
// BEFORE that import evaluates. Manual cleanup in AfterEachScenario replaces it.
vi.hoisted(() => {
  process.env.STL_SKIP_AUTO_CLEANUP = "true";
});

// happy-dom's localStorage lacks .clear()/.removeItem() reliably — same shim
// as SettingsPage.test.tsx, needed because stores/config and stores/auth read
// localStorage at module-evaluation time.
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
  configurable: true,
});

// ── Mocks ─────────────────────────────────────────────────────────────────────
// The scenarios render the real App (header star, What's New dialog, Settings
// About row, config persistence). Only the GitHub-facing services and the
// Sentry/IndexedDB side channels are stubbed.

// Stands in for a blocked `_virtual_changelog-<hash>.js` request in a production build:
// while `blocked` is set, reading the changelog module does what Vite's preload helper does
// on a failed chunk — dispatch a cancelable `vite:preloadError` on window, then fail the
// import unless a listener cancelled it — so the app's chunk-reload handler and
// loadChangelog()'s real failure path (empty list, cache cleared for a retry) both run.
const changelogChunk = vi.hoisted(() => ({ blocked: false }));

vi.mock("virtual:changelog", async () => {
  const fixture = await vi.importActual<typeof import("../../stubs/virtual-changelog")>(
    "../../stubs/virtual-changelog",
  );
  return {
    get default() {
      if (changelogChunk.blocked) {
        const error = new TypeError("Failed to fetch dynamically imported module: /_app/_virtual_changelog.js");
        const event = new Event("vite:preloadError", { cancelable: true });
        Object.assign(event, { payload: error });
        window.dispatchEvent(event);
        if (event.defaultPrevented) return undefined;
        throw error;
      }
      return fixture.default;
    },
  };
});

vi.mock("../../../src/app/stores/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/app/stores/auth")>();
  return {
    ...actual,
    token: () => "fake-token",
    user: () => ({ login: "testuser", avatar_url: "", name: "Test User" }),
    isAuthenticated: () => true,
    validateToken: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("../../../src/app/lib/dashboard-snapshot", () => ({
  loadSnapshot: vi.fn().mockResolvedValue(null),
  writeSnapshot: vi.fn(),
  flushSnapshot: vi.fn().mockResolvedValue(undefined),
  clearSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/app/lib/sentry-facade", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/app/lib/sentry-facade")>();
  return { ...actual, captureException: vi.fn(), reportBoundaryError: vi.fn() };
});

vi.mock("../../../src/app/stores/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/app/stores/cache")>();
  return {
    ...actual,
    clearCache: vi.fn().mockResolvedValue(undefined),
    evictStaleEntries: vi.fn().mockResolvedValue(0),
    evictKeysWithPrefix: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../../src/app/lib/mcp-relay", () => ({
  initMcpRelay: vi.fn(),
}));

vi.mock("../../../src/app/services/jira-client", () => ({
  JiraClient: vi.fn(),
  JiraProxyClient: vi.fn(),
}));

vi.mock("../../../src/app/services/jira-keys", () => ({
  detectAndLookupJiraKeys: vi.fn().mockResolvedValue(new Map()),
  clearJiraKeyCache: vi.fn(),
}));

vi.mock("../../../src/app/services/github", () => ({
  getCoreRateLimit: () => null,
  getGraphqlRateLimit: () => null,
  getClient: vi.fn(() => null),
  fetchRateLimitDetails: vi.fn(),
  onApiRequest: vi.fn(),
  initClientWatcher: vi.fn(),
}));

vi.mock("../../../src/app/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/app/services/api")>();
  return {
    ...actual,
    fetchOrgs: vi.fn().mockResolvedValue([]),
    fetchRepos: vi.fn().mockResolvedValue([]),
    discoverUpstreamRepos: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../../../src/app/services/poll", () => ({
  fetchAllData: vi.fn(),
  createPollCoordinator: vi.fn(),
  createHotPollCoordinator: vi.fn(),
  createEventsPollCoordinator: vi.fn(),
  rebuildHotSets: vi.fn(),
  seedHotSetsFromTargeted: vi.fn(),
  clearHotSets: vi.fn(),
  getHotPollGeneration: vi.fn().mockReturnValue(0),
  StaleIdentityError: class StaleIdentityError extends Error {
    constructor() {
      super("Stale identity");
      this.name = "StaleIdentityError";
    }
  },
}));

vi.mock("../../../src/app/lib/notifications", () => ({
  detectNewItems: vi.fn(() => []),
  dispatchNotifications: vi.fn(),
  _resetNotificationState: vi.fn(),
}));

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { screen, cleanup, within, fireEvent } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import {
  CHANGELOG_URL,
  RUNNING_SHA,
  closeDialog,
  expectNoDocumentNavigation,
  findDialog,
  buildInfo,
  findSettingsHeading,
  installNoAnimationStyle,
  observeDocumentNavigations,
  openDashboard,
  queryBanner,
  queryDialog,
  resetSignedInApp,
  serveVersion,
  storedConfig,
  versionRequestCount,
  visibleToasts,
  waitPastPersistenceDebounce,
  whatsNewButton,
  installNetwork,
  type NavigationSpies,
} from "../support/app-harness";

import * as configStore from "../../../src/app/stores/config";
import { resetNotificationState } from "../../../src/app/lib/errors";
import { installChunkReloadHandler } from "../../../src/app/lib/chunk-reload";
import { _resetChangelogCacheForTests, isStrictSemver, loadChangelog } from "../../../src/app/lib/changelog";
import {
  getAppVersion,
  _resetVersionStateForTests,
  _setAppVersionForTests,
  _setGitShaForTests,
} from "../../../src/app/lib/version";
import changelogFixture from "../../stubs/virtual-changelog";

const feature = await loadFeature("../whats-new-dialog.feature");

installNoAnimationStyle();
// vitest-cucumber runs the Background steps before BeforeEachScenario, so version state
// (set by the Background) is reset here and after each scenario, never before one.
_resetVersionStateForTests();

afterAll(() => {
  delete process.env.STL_SKIP_AUTO_CLEANUP;
});

// The running build matches the fixture changelog's newest release.
const RUNNING_VERSION = "0.1.0";
const TOP_RELEASE = changelogFixture[0];
const UNREAD_LABEL = "What's new, unread release notes";

/** Writes a config to storage the way another tab or an earlier session left it. */
function seedStoredConfig(partial: Record<string, unknown>): void {
  const current = JSON.parse(JSON.stringify(configStore.config)) as Record<string, unknown>;
  localStorage.setItem(configStore.CONFIG_STORAGE_KEY, JSON.stringify({ ...current, ...partial }));
}

/** Waits until the header's idle-time changelog load has settled and rendered. */
async function headerChangelogLoaded(): Promise<void> {
  await loadChangelog();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function whatsNewDot(): HTMLElement | null {
  return within(whatsNewButton()).queryByTestId("whats-new-dot");
}

// The footer "Close" button is a Kobalte Dialog.CloseButton, whose accessible name is
// Kobalte's default "Dismiss"; the header × button carries an explicit label.
function closeWhatsNew(): Promise<void> {
  return closeDialog("What's New", "Close what's new");
}

async function openHeaderWhatsNew(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: /^What's new/ }));
  return findDialog("What's New");
}

interface DialogSummary {
  firstVersion: string | null;
  firstDate: string | null;
  links: Array<{ text: string; href: string | null; target: string | null }>;
  footerHref: string | null;
}

function summarizeWhatsNew(dialog: HTMLElement): DialogSummary {
  const first = dialog.querySelector("section");
  return {
    firstVersion: first?.querySelector("h3")?.textContent ?? null,
    firstDate: first?.querySelector("h3 + span")?.textContent ?? null,
    links: within(dialog)
      .queryAllByRole("link")
      .map((a) => ({
        text: a.textContent ?? "",
        href: a.getAttribute("href"),
        target: a.getAttribute("target"),
      })),
    footerHref: within(dialog).getByRole("link", { name: "Full changelog on GitHub" }).getAttribute("href"),
  };
}

describeFeature(
  feature,
  ({ Scenario, Background, BeforeEachScenario, AfterEachScenario }) => {
    let navigations: NavigationSpies;
    let removeChunkReloadHandler: (() => void) | undefined;

    BeforeEachScenario(() => {
      resetSignedInApp();
      changelogChunk.blocked = false;
      _resetChangelogCacheForTests();
      navigations = observeDocumentNavigations();
    });

    AfterEachScenario(() => {
      cleanup();
      removeChunkReloadHandler?.();
      removeChunkReloadHandler = undefined;
      vi.restoreAllMocks();
      changelogChunk.blocked = false;
      _resetChangelogCacheForTests();
      _resetVersionStateForTests();
      resetNotificationState();
      window.history.pushState({}, "", "/");
    });

    Background(({ Given, And }) => {
      Given("the user is authenticated with a GitHub account", () => {
        // stores/auth is mocked as signed in for every scenario in this file.
      });

      And("the running build's version is a strict x.y.z semver", () => {
        _setAppVersionForTests(RUNNING_VERSION);
        _setGitShaForTests(RUNNING_SHA);
        expect(isStrictSemver(getAppVersion())).toBe(true);
      });
    });

    // ── S26 ───────────────────────────────────────────────────────────────────
    Scenario(
      "S26 - Header What's new star shows an unread dot and accessible label when a newer release exists",
      ({ Given, When, Then, And }) => {
        Given("a release newer than the user's last-seen version is in the changelog", () => {
          seedStoredConfig({ lastSeenVersion: "0.0.1" });
          expect(TOP_RELEASE.version).toBe(RUNNING_VERSION);
        });

        When("the dashboard header has finished its idle-time changelog load", async () => {
          await openDashboard();
          expect(configStore.config.lastSeenVersion).toBe("0.0.1");
          await headerChangelogLoaded();
        });

        Then(
          'the star icon button (directly after the notifications bell) shows a small dot and its accessible name is "What\'s new, unread release notes"',
          () => {
            const star = whatsNewButton();
            expect(star.getAttribute("aria-label")).toBe(UNREAD_LABEL);
            const dot = whatsNewDot();
            expect(dot).not.toBeNull();
            for (const cls of ["absolute", "top-1", "right-1", "rounded-full", "h-2", "w-2"]) {
              expect(dot!.classList.contains(cls)).toBe(true);
            }
            // Each header button sits in its own tooltip trigger; the star's follows the bell's.
            const bell = screen.getByRole("button", { name: /^Notifications/ });
            expect(bell.parentElement?.nextElementSibling).toBe(star.parentElement);
          },
        );

        And('hovering the button shows the "What\'s new" tooltip', async () => {
          const user = userEvent.setup();
          await user.hover(whatsNewButton());
          const tooltip = await screen.findByRole("tooltip");
          expect(tooltip.textContent).toBe("What's new");
        });
      },
    );

    // ── S29 ───────────────────────────────────────────────────────────────────
    Scenario(
      "S29 - Older-build tab opening What's New never rolls lastSeenVersion back",
      ({ Given, When, Then, And }) => {
        let dotBeforeOpening: HTMLElement | null = null;

        Given("the stored last-seen version is newer than this tab's build version", async () => {
          seedStoredConfig({ lastSeenVersion: "9.9.9" });
          await openDashboard();
          // The tab adopted what is on disk.
          expect(configStore.config.lastSeenVersion).toBe("9.9.9");
        });

        When("the user opens and closes What's New in this tab", async () => {
          await headerChangelogLoaded();
          dotBeforeOpening = whatsNewDot();
          const dialog = await openHeaderWhatsNew();
          await within(dialog).findByText(`v${TOP_RELEASE.version}`);
          await closeWhatsNew();
          await waitPastPersistenceDebounce();
        });

        Then("the stored last-seen version is unchanged", () => {
          expect(configStore.config.lastSeenVersion).toBe("9.9.9");
          expect(storedConfig()?.lastSeenVersion).toBe("9.9.9");
        });

        And("no unread dot is shown before or after", () => {
          expect(dotBeforeOpening).toBeNull();
          expect(whatsNewDot()).toBeNull();
          expect(whatsNewButton().getAttribute("aria-label")).toBe("What's new");
        });
      },
    );

    // ── S30 ───────────────────────────────────────────────────────────────────
    Scenario("S30 - Settings > About \"What's new\" button opens the same dialog", ({ Given, When, Then, And }) => {
      let settingsSummary: DialogSummary | undefined;

      Given("the user is on Settings", async () => {
        seedStoredConfig({ lastSeenVersion: "0.0.1" });
        await openDashboard();
        expect(configStore.config.lastSeenVersion).toBe("0.0.1");
        await headerChangelogLoaded();
        expect(whatsNewDot()).not.toBeNull();
        const user = userEvent.setup();
        await user.click(screen.getByRole("link", { name: "Settings" }));
        await findSettingsHeading();
        // Settings renders no header star.
        expect(screen.queryByRole("button", { name: UNREAD_LABEL })).toBeNull();
      });

      When('the user clicks "What\'s new" in the About row and waits for the notes to load', async () => {
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "What's new" }));
        const dialog = await findDialog("What's New");
        await within(dialog).findByText(`v${TOP_RELEASE.version}`);
        await waitPastPersistenceDebounce();
      });

      Then(
        'the "What\'s New" dialog shows the same first entry (version and date) as the header dialog, with the same links and footer',
        async () => {
          const dialog = await findDialog("What's New");
          settingsSummary = summarizeWhatsNew(dialog);
          expect(settingsSummary.firstVersion).toBe(`v${TOP_RELEASE.version}`);
          expect(settingsSummary.firstDate).toBe(TOP_RELEASE.date);
          const firstItem = TOP_RELEASE.sections[0].items[0];
          expect(settingsSummary.links).toContainEqual({
            text: `#${firstItem.pr}`,
            href: `https://github.com/gordon-code/github-tracker/pull/${firstItem.pr}`,
            target: "_blank",
          });
          expect(settingsSummary.links).toContainEqual({
            text: `(${firstItem.sha})`,
            href: `https://github.com/gordon-code/github-tracker/commit/${firstItem.sha}`,
            target: "_blank",
          });
          expect(settingsSummary.footerHref).toBe(CHANGELOG_URL);
        },
      );

      And("after closing it and returning to the dashboard the header dot is gone", async () => {
        await closeWhatsNew();
        const user = userEvent.setup();
        await user.click(await screen.findByRole("link", { name: "Back to dashboard" }));
        await screen.findByRole("tablist", {}, { timeout: 5_000 });
        await headerChangelogLoaded();
        expect(whatsNewDot()).toBeNull();
        expect(whatsNewButton().getAttribute("aria-label")).toBe("What's new");
        expect(storedConfig()?.lastSeenVersion).toBe(RUNNING_VERSION);

        // The header dialog shows the same notes, links and footer as the Settings one.
        const headerDialog = await openHeaderWhatsNew();
        await within(headerDialog).findByText(`v${TOP_RELEASE.version}`);
        expect(summarizeWhatsNew(headerDialog)).toEqual(settingsSummary);
      });
    });

    // ── S31 ───────────────────────────────────────────────────────────────────
    Scenario(
      'S31 - Blocked or empty changelog shows "No release notes available." and retries on next open without reloading',
      ({ Given, When, Then }) => {
        let secondOpenEmpty = false;
        let secondOpenEntries = -1;

        let checksBeforeOpen = 0;

        Given("the changelog chunk cannot be loaded", async () => {
          // index.tsx installs the chunk-reload handler at startup; /version.json reports the
          // running build, so a failed chunk alone must not reload the page.
          removeChunkReloadHandler = installChunkReloadHandler();
          serveVersion({ kind: "json", body: buildInfo(RUNNING_SHA) });
          installNetwork();
          changelogChunk.blocked = true;
          await openDashboard();
          // The header's idle-time load has already failed, and its preload error ran a check.
          await headerChangelogLoaded();
          await vi.waitFor(() => expect(versionRequestCount()).toBeGreaterThanOrEqual(1));
          expect(queryBanner()).toBeNull();
        });

        When("the user opens What's New", async () => {
          installNetwork();
          checksBeforeOpen = versionRequestCount();
          await openHeaderWhatsNew();
          await new Promise((resolve) => setTimeout(resolve, 50));
        });

        Then('the dialog shows "No release notes available.", no error toast appears, and the page does not reload', () => {
          const dialog = queryDialog("What's New");
          expect(dialog).not.toBeNull();
          within(dialog!).getByText("No release notes available.");
          expect(dialog!.querySelectorAll("section")).toHaveLength(0);
          expect(visibleToasts()).toHaveLength(0);
          // The failed import reached the chunk-reload handler, whose check found no newer build.
          expect(versionRequestCount()).toBeGreaterThan(checksBeforeOpen);
          expect(queryBanner()).toBeNull();
          expectNoDocumentNavigation(navigations);
        });

        When(
          "the block is still active and the user opens it again, and then removes the block and opens it once more",
          async () => {
            installNetwork();
            await closeWhatsNew();
            const second = await openHeaderWhatsNew();
            await new Promise((resolve) => setTimeout(resolve, 50));
            secondOpenEmpty = within(second).queryByText("No release notes available.") !== null;
            secondOpenEntries = second.querySelectorAll("section").length;
            await closeWhatsNew();

            changelogChunk.blocked = false;
            await openHeaderWhatsNew();
          },
        );

        Then(
          "the second open is still empty and the third open renders the entries within a few seconds without closing the dialog",
          async () => {
            expect(secondOpenEmpty).toBe(true);
            expect(secondOpenEntries).toBe(0);
            const third = await findDialog("What's New");
            await within(third).findByText(`v${TOP_RELEASE.version}`, {}, { timeout: 3_000 });
            // The entries rendered into the dialog that was already open.
            expect(queryDialog("What's New")).toBe(third);
            expect(third.querySelectorAll("section")).toHaveLength(changelogFixture.length);
            expect(visibleToasts()).toHaveLength(0);
            expectNoDocumentNavigation(navigations);
          },
        );
      },
    );
  },
  { excludeTags: ["manual", "e2e"] },
);

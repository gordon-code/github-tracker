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
// The scenarios render the real App: router, UpdateNavigator, UpdateBanner, the
// version watcher, config/view persistence, the notification store, the header's
// drawer and toasts, and the Dashboard, Settings and Onboarding pages. Only the
// GitHub-facing services and the Sentry/IndexedDB side channels are stubbed;
// /version.json is served through a stubbed fetch (tests/acceptance/support).

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
  getClient: vi.fn(() => ({})),
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
import { screen, waitFor, cleanup, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { findCheckboxByLabelText } from "../../helpers/index";
import {
  BANNER_TEXT,
  CHANGELOG_URL,
  DEPLOYED_SHA,
  DRAWER_TEXT,
  FOREIGN_SCHEMA_FP,
  READ_ONLY_SENTENCE,
  RUNNING_SHA,
  bellButton,
  buildInfo,
  drawerUpdateEntries,
  expectNoDocumentNavigation,
  findSettingsHeading,
  getBanner,
  installNoAnimationStyle,
  isDisabled,
  observeDocumentNavigations,
  openDashboard,
  queryBanner,
  readDrawer,
  renderAppAt,
  resetSignedInApp,
  serveVersion,
  storedConfig,
  switchAwayAndBack,
  versionRequestCount,
  visibleToasts,
  waitPastPersistenceDebounce,
  type NavigationSpies,
  type VersionReply,
} from "../support/app-harness";

import * as apiService from "../../../src/app/services/api";
import * as configStore from "../../../src/app/stores/config";
import { getNotifications, resetNotificationState } from "../../../src/app/lib/errors";
import { GIT_SHA, _resetVersionStateForTests, _setGitShaForTests } from "../../../src/app/lib/version";

const feature = await loadFeature("../update-detection-and-resilience.feature");

installNoAnimationStyle();
// vitest-cucumber runs the Background steps before BeforeEachScenario, so version state
// (set by the Background) is reset here and after each scenario, never before one.
_resetVersionStateForTests();

afterAll(() => {
  delete process.env.STL_SKIP_AUTO_CLEANUP;
});

describeFeature(
  feature,
  ({ Scenario, Background, BeforeEachScenario, AfterEachScenario }) => {
    let navigations: NavigationSpies;

    BeforeEachScenario(() => {
      resetSignedInApp();
      navigations = observeDocumentNavigations();
    });

    AfterEachScenario(() => {
      cleanup();
      vi.restoreAllMocks();
      // clearAllMocks keeps implementations, so undo S17's org/repo responses here.
      vi.mocked(apiService.fetchOrgs).mockResolvedValue([]);
      vi.mocked(apiService.fetchRepos).mockResolvedValue([]);
      _resetVersionStateForTests();
      resetNotificationState();
      window.history.pushState({}, "", "/");
    });

    Background(({ Given, And }) => {
      Given("the user has a GitHub account and is signed in unless the scenario says otherwise", () => {
        // stores/auth is mocked as signed in for every scenario in this file.
      });

      And('the running build\'s git SHA is not "dev"', () => {
        expect(GIT_SHA).not.toBe("dev");
        _setGitShaForTests(RUNNING_SHA);
      });
    });

    // ── S4 ────────────────────────────────────────────────────────────────────
    Scenario(
      "S4 - Update banner appears when a newer build is deployed, with a drawer entry and no toast",
      ({ Given, When, Then, And }) => {
        Given("the dashboard is open and the deployed build's SHA differs from the running build's SHA", async () => {
          serveVersion({ kind: "json", body: buildInfo(DEPLOYED_SHA) });
          await openDashboard();
          expect(queryBanner()).toBeNull();
          expect(bellButton().getAttribute("aria-label")).toBe("Notifications");
        });

        When("the user switches away from the tab and back (or waits 30 seconds after load)", async () => {
          await switchAwayAndBack();
        });

        Then(
          'a bottom-centre banner appears reading "A new version is available." with a "Reload" button and a "Changelog" link',
          async () => {
            const banner = await waitFor(getBanner);
            for (const cls of ["fixed", "bottom-4", "inset-x-4", "mx-auto"]) {
              expect(banner.classList.contains(cls)).toBe(true);
            }
            expect(banner.textContent).not.toContain(READ_ONLY_SENTENCE);
            within(banner).getByRole("button", { name: "Reload" });
            const changelog = within(banner).getByRole("link", { name: "Changelog" });
            expect(changelog.getAttribute("href")).toBe(CHANGELOG_URL);
            expect(changelog.getAttribute("target")).toBe("_blank");
          },
        );

        And(
          'the Notification Drawer gains one info entry "A new version of GitHub Tracker is available — reload to update." without a pop-up toast',
          async () => {
            expect(visibleToasts()).toHaveLength(0);
            expect(bellButton().getAttribute("aria-label")).toBe("Notifications, 1 unread");

            // Further checks reporting the same build add no entries and no toast.
            await switchAwayAndBack();
            await switchAwayAndBack();
            expect(visibleToasts()).toHaveLength(0);

            const entries = await drawerUpdateEntries();
            expect(entries).toHaveLength(1);
            expect(entries[0].classList.contains("border-l-info")).toBe(true);
          },
        );
      },
    );

    // ── S5 ────────────────────────────────────────────────────────────────────
    Scenario(
      "S5 - No banner and client-side navigation when the deployed build matches",
      ({ Given, When, Then, And }) => {
        Given("the deployed build's SHA matches the running build", async () => {
          serveVersion({ kind: "json", body: buildInfo(RUNNING_SHA) });
          await openDashboard();
        });

        When('the user returns to the tab and then clicks the header "Settings" link', async () => {
          await switchAwayAndBack();
          expect(versionRequestCount()).toBe(1);
          // The bell (rendered on the dashboard only) still shows no unread entry.
          expect(bellButton().getAttribute("aria-label")).toBe("Notifications");
          const user = userEvent.setup();
          await user.click(screen.getByRole("link", { name: "Settings" }));
        });

        Then("no update banner is shown and no drawer entry is added", () => {
          expect(queryBanner()).toBeNull();
          expect(getNotifications().some((n) => n.message === DRAWER_TEXT)).toBe(false);
        });

        And("the Settings page opens as a client-side route change without a full document reload", async () => {
          await findSettingsHeading();
          expect(window.location.pathname).toBe("/settings");
          expectNoDocumentNavigation(navigations);

          // Positive control: the same check flags a different SHA, so the absence
          // above reflects the SHA comparison and not a check that never ran.
          serveVersion({ kind: "json", body: buildInfo(DEPLOYED_SHA) });
          await switchAwayAndBack();
          await waitFor(getBanner);
        });
      },
    );

    // ── S9 ────────────────────────────────────────────────────────────────────
    Scenario("S9 - Banner and drawer entry clear after a rollback", ({ Given, When, Then, And }) => {
      Given("the update banner is visible and the drawer holds the update entry", async () => {
        serveVersion({ kind: "json", body: buildInfo(DEPLOYED_SHA) });
        await openDashboard();
        await switchAwayAndBack();
        await waitFor(getBanner);
        expect(await drawerUpdateEntries()).toHaveLength(1);
      });

      When("a later check reports the running build's SHA again", async () => {
        serveVersion({ kind: "json", body: buildInfo(RUNNING_SHA) });
        await switchAwayAndBack();
      });

      Then("the banner disappears", async () => {
        await waitFor(() => expect(queryBanner()).toBeNull());
      });

      And("the update entry is removed from the Notification Drawer", async () => {
        expect(await drawerUpdateEntries()).toHaveLength(0);

        // A later update re-shows the banner and exactly one drawer entry.
        serveVersion({ kind: "json", body: buildInfo(DEPLOYED_SHA) });
        await switchAwayAndBack();
        await waitFor(getBanner);
        expect(await drawerUpdateEntries()).toHaveLength(1);
      });
    });

    // ── S12 ───────────────────────────────────────────────────────────────────
    Scenario(
      "S12 - HTML, failed or malformed /version.json responses are ignored silently",
      ({ Given, When, Then, And }) => {
        const badReplies: VersionReply[] = [
          { kind: "html" },
          { kind: "network-error" },
          { kind: "json", body: { version: "9.9.9" } },
          // A different SHA but no builtAt: only schema validation keeps this out.
          { kind: "json", body: { version: "9.9.9", sha: DEPLOYED_SHA } },
        ];

        Given(
          "/version.json returns the SPA's HTML fallback, fails to load, or returns JSON missing required fields",
          async () => {
            await openDashboard();
            expect(queryBanner()).toBeNull();
          },
        );

        When("the update check runs", async () => {
          for (const reply of badReplies) {
            serveVersion(reply);
            await switchAwayAndBack();
          }
          expect(versionRequestCount()).toBe(badReplies.length);
        });

        Then("no banner appears, no toast appears, and nothing is added to the Notification Drawer", async () => {
          expect(queryBanner()).toBeNull();
          expect(visibleToasts()).toHaveLength(0);
          expect(bellButton().getAttribute("aria-label")).toBe("Notifications");
          const drawer = await readDrawer();
          expect(drawer.entries).toHaveLength(0);
          expect(drawer.empty).toBe(true);
        });

        And("a later valid response with a different SHA still shows the banner", async () => {
          serveVersion({ kind: "json", body: buildInfo(DEPLOYED_SHA) });
          await switchAwayAndBack();
          await waitFor(getBanner);
        });
      },
    );

    // ── S16 ───────────────────────────────────────────────────────────────────
    Scenario(
      "S16 - Older-build tab becomes read-only when the deployed storage schema differs",
      ({ Given, When, Then, And }) => {
        let configBefore: string | null = null;

        Given("the deployed build reports a schema fingerprint different from this tab's build", async () => {
          configStore.updateConfig({ theme: "dracula" });
          serveVersion({ kind: "json", body: buildInfo(DEPLOYED_SHA, { schemaFp: FOREIGN_SCHEMA_FP }) });
          renderAppAt("/settings");
          await findSettingsHeading();
          // Let the initial persistence commit land so storage holds this tab's settings.
          await waitFor(() => expect(storedConfig()?.theme).toBe("dracula"));
          expect(document.documentElement.getAttribute("data-theme")).toBe("dracula");
          expect(isDisabled(screen.getByRole("button", { name: "Sign out" }))).toBe(false);
          configBefore = localStorage.getItem(configStore.CONFIG_STORAGE_KEY);
        });

        When("the update check runs", async () => {
          await switchAwayAndBack();
        });

        Then(
          'the banner reads "A new version is available. This tab can\'t save changes, and Settings are read-only, until you reload."',
          async () => {
            const banner = await waitFor(getBanner);
            expect(banner.textContent?.replace(/\s+/g, " ")).toContain(`${BANNER_TEXT} ${READ_ONLY_SENTENCE}`);
          },
        );

        And(
          "the Settings content is a disabled inert region, so Sign out, Export, the dropdowns and the theme options are disabled and a forced click on a theme option changes nothing",
          async () => {
            const regions = document.querySelectorAll<HTMLFieldSetElement>("fieldset[inert]");
            expect(regions).toHaveLength(1);
            const region = regions[0];
            expect(region.disabled).toBe(true);

            // happy-dom does not apply a disabled fieldset to its descendants' :disabled
            // state, so isDisabled() checks the fieldset ancestry the HTML spec uses.
            for (const name of ["Sign out", "Export"]) {
              const control = screen.getByRole("button", { name });
              expect(region.contains(control)).toBe(true);
              expect(isDisabled(control)).toBe(true);
            }
            // Kobalte select triggers and the theme options are disabled themselves too.
            const selectTriggers = Array.from(region.querySelectorAll<HTMLButtonElement>("button.select"));
            expect(selectTriggers.length).toBeGreaterThanOrEqual(3);
            for (const trigger of selectTriggers) expect(trigger.disabled).toBe(true);
            const themeOptions = Array.from(
              region.querySelectorAll<HTMLButtonElement>('button[aria-label^="Theme: "]'),
            );
            expect(themeOptions.length).toBeGreaterThan(1);
            for (const option of themeOptions) expect(option.disabled).toBe(true);

            // "Back to dashboard" sits outside the region and stays usable.
            const back = screen.getByRole("link", { name: "Back to dashboard" });
            expect(region.contains(back)).toBe(false);

            const autoOption = region.querySelector<HTMLButtonElement>('button[aria-label^="Theme: auto"]');
            expect(autoOption).not.toBeNull();
            autoOption!.click();
            await waitPastPersistenceDebounce();
            expect(document.documentElement.getAttribute("data-theme")).toBe("dracula");
            expect(configStore.config.theme).toBe("dracula");
            expect(localStorage.getItem(configStore.CONFIG_STORAGE_KEY)).toBe(configBefore);
          },
        );
      },
    );

    // ── S17 ───────────────────────────────────────────────────────────────────
    Scenario("S17 - Older-build tab refuses to finish onboarding", ({ Given, When, Then, And }) => {
      Given(
        "the tab is read-only because of a schema mismatch and the user has selected repos in the onboarding wizard",
        async () => {
          configStore.resetConfig();
          vi.mocked(apiService.fetchOrgs).mockResolvedValue([
            { login: "testorg", avatarUrl: "", type: "org" },
          ]);
          vi.mocked(apiService.fetchRepos).mockResolvedValue([
            { owner: "testorg", name: "alpha", fullName: "testorg/alpha", pushedAt: "2026-11-01T00:00:00Z" },
          ]);
          serveVersion({ kind: "json", body: buildInfo(DEPLOYED_SHA, { schemaFp: FOREIGN_SCHEMA_FP }) });

          renderAppAt("/onboarding");
          await screen.findByText("GitHub Tracker Setup", {}, { timeout: 5_000 });
          // The banner and the version check are mounted on every route.
          await switchAwayAndBack();
          await waitFor(() => expect(getBanner().textContent).toContain(READ_ONLY_SENTENCE));

          await waitFor(() => findCheckboxByLabelText("alpha"), { timeout: 5_000 });
          const user = userEvent.setup();
          await user.click(findCheckboxByLabelText("alpha"));
          await screen.findByRole("button", { name: "Finish Setup (1 repo)" });
        },
      );

      When('the user clicks "Finish Setup (N repos)"', async () => {
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Finish Setup (1 repo)" }));
        await waitPastPersistenceDebounce();
      });

      Then(
        'the wizard stays on /onboarding and replaces the selector with the alert "This tab is on an older version and can\'t save your choices. Reload this page, then finish setup." and a "Retry" button',
        async () => {
          await screen.findByText(
            "This tab is on an older version and can't save your choices. Reload this page, then finish setup.",
          );
          screen.getByRole("button", { name: "Retry" });
          expect(screen.queryByRole("checkbox")).toBeNull();
          expect(window.location.pathname).toBe("/onboarding");
          expectNoDocumentNavigation(navigations);
        },
      );

      And("no repo selection is written to storage", () => {
        const selected = storedConfig()?.selectedRepos;
        expect(selected === undefined || (Array.isArray(selected) && selected.length === 0)).toBe(true);
        expect(configStore.config.onboardingComplete).toBe(false);
      });
    });
  },
  { excludeTags: ["manual", "e2e"] },
);

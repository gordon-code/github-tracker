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
// The scenarios render the real App (Settings About row, dashboard footer). Only the
// GitHub-facing services and the Sentry/IndexedDB side channels are stubbed.

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
import { screen, cleanup, within } from "@solidjs/testing-library";
import {
  CHANGELOG_URL,
  RELEASES_URL,
  RUNNING_SHA,
  installNoAnimationStyle,
  openDashboard,
  openSettings,
  resetSignedInApp,
} from "../support/app-harness";

import {
  GIT_SHA,
  _resetVersionStateForTests,
  _setAppVersionForTests,
  _setGitShaForTests,
} from "../../../src/app/lib/version";

const feature = await loadFeature("../build-metadata-and-version-display.feature");

installNoAnimationStyle();
// vitest-cucumber runs the Background steps before BeforeEachScenario, so version state
// (set by the Background) is reset here and after each scenario, never before one.
_resetVersionStateForTests();

afterAll(() => {
  delete process.env.STL_SKIP_AUTO_CLEANUP;
});

// A running build distinct from the Vitest build constants, so the display is shown
// to come from the running build's version and SHA rather than fixed text.
const RUNNING_VERSION = "0.1.1";
const DISPLAYED_BUILD = `${RUNNING_VERSION}+${RUNNING_SHA.slice(0, 7)}`;

function expectNewTabLink(link: HTMLElement, href: string): void {
  expect(link.getAttribute("href")).toBe(href);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toContain("noopener");
}

describeFeature(
  feature,
  ({ Scenario, Background, BeforeEachScenario, AfterEachScenario }) => {
    BeforeEachScenario(() => {
      resetSignedInApp();
    });

    AfterEachScenario(() => {
      cleanup();
      vi.restoreAllMocks();
      _resetVersionStateForTests();
      window.history.pushState({}, "", "/");
    });

    Background(({ Given, And }) => {
      Given("the user is authenticated with a GitHub account", () => {
        // stores/auth is mocked as signed in for every scenario in this file.
      });

      And('the running build\'s git SHA is not "dev"', () => {
        expect(GIT_SHA).not.toBe("dev");
        _setAppVersionForTests(RUNNING_VERSION);
        _setGitShaForTests(RUNNING_SHA);
      });
    });

    // ── S1 ────────────────────────────────────────────────────────────────────
    Scenario(
      "S1 - Settings > About shows the running version with Releases, What's new and Changelog",
      ({ Given, When, Then, And }) => {
        let aboutRow: HTMLElement;

        Given("the user is signed in and opens Settings", async () => {
          await openSettings();
        });

        When("the user scrolls to the Data section", () => {
          // The About row is the last row of the Data section, directly below Sign out.
          const signOutRow = screen.getByRole("button", { name: "Sign out" }).closest("div.flex.items-center.justify-between");
          const label = screen.getByText("About", { selector: "p, span, div, label" });
          const row = label.closest("div.flex.items-center.justify-between");
          expect(row).not.toBeNull();
          aboutRow = row as HTMLElement;
          expect(signOutRow?.nextElementSibling).toBe(aboutRow);
        });

        Then(
          'an "About" row shows the running build as "<version>+<7-character SHA>" linking to https://github.com/gordon-code/github-tracker/releases in a new tab',
          () => {
            const versionLink = within(aboutRow).getByRole("link", { name: DISPLAYED_BUILD });
            expect(versionLink.textContent).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{7}$/);
            expectNewTabLink(versionLink, RELEASES_URL);
          },
        );

        And(
          'the same row offers a "What\'s new" button and a "Changelog" link to https://github.com/gordon-code/github-tracker/blob/main/CHANGELOG.md',
          () => {
            within(aboutRow).getByRole("button", { name: "What's new" });
            expectNewTabLink(within(aboutRow).getByRole("link", { name: "Changelog" }), CHANGELOG_URL);
            // Exactly three controls: version link, "What's new" button, "Changelog" link.
            const controls = aboutRow.querySelectorAll("a, button");
            expect(Array.from(controls, (el) => el.textContent?.trim())).toEqual([
              DISPLAYED_BUILD,
              "What's new",
              "Changelog",
            ]);
          },
        );
      },
    );

    // ── S2 ────────────────────────────────────────────────────────────────────
    Scenario("S2 - Dashboard footer shows the running version linking to Releases", ({ Given, When, Then, And }) => {
      let footer: HTMLElement;

      Given("the user is on the dashboard", async () => {
        await openDashboard();
      });

      When('the user looks at the fixed footer beside the "Source", "Guide" and "Privacy" links', () => {
        footer = screen.getByRole("contentinfo");
        expect(footer.classList.contains("fixed")).toBe(true);
        expect(footer.classList.contains("bottom-0")).toBe(true);
        for (const name of ["Source", "Guide", "Privacy"]) within(footer).getByRole("link", { name });
      });

      Then('a muted monospace "v<version>+<7-character SHA>" link is shown', () => {
        const versionLink = within(footer).getByRole("link", { name: `v${DISPLAYED_BUILD}` });
        expect(versionLink.classList.contains("font-mono")).toBe(true);
        expect(versionLink.classList.contains("text-base-content/40")).toBe(true);
        // It sits in the same group, right after Privacy.
        const groupLinks = Array.from(
          versionLink.parentElement!.querySelectorAll("a"),
          (a) => a.textContent?.trim(),
        );
        expect(groupLinks).toEqual(["Source", "Guide", "Privacy", `v${DISPLAYED_BUILD}`]);
      });

      And("clicking it opens https://github.com/gordon-code/github-tracker/releases in a new tab", () => {
        expectNewTabLink(within(footer).getByRole("link", { name: `v${DISPLAYED_BUILD}` }), RELEASES_URL);
      });
    });
  },
  { excludeTags: ["manual", "e2e"] },
);

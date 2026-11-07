import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { MemoryRouter, Route, useNavigate, createMemoryHistory } from "@solidjs/router";
import { createRoot } from "solid-js";
import UpdateBanner from "../../../src/app/components/shared/UpdateBanner";
import { UpdateNavigator } from "../../../src/app/App";
import {
  _setUpdateAvailableForTests,
  _resetVersionStateForTests,
} from "../../../src/app/lib/version";
import {
  getNotifications,
  resetNotificationState,
} from "../../../src/app/lib/errors";
import {
  CONFIG_STORAGE_KEY,
  updateConfig,
  resetConfig,
  initConfigPersistence,
} from "../../../src/app/stores/config";
import {
  VIEW_STORAGE_KEY,
  updateViewState,
  resetViewState,
  initViewPersistence,
} from "../../../src/app/stores/view";

describe("UpdateBanner & UpdateNavigator", () => {
  const originalLocation = window.location;
  let reloadMock: ReturnType<typeof vi.fn>;
  let assignMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    localStorage.clear();
    _resetVersionStateForTests();
    resetNotificationState();
    resetConfig();
    resetViewState();

    reloadMock = vi.fn();
    assignMock = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        reload: reloadMock,
        assign: assignMock,
        pathname: "/",
        search: "",
        hash: "",
        href: "",
      },
    });
  });

  afterEach(() => {
    _resetVersionStateForTests();
    resetNotificationState();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
    vi.useRealTimers();
  });

  describe("UpdateBanner", () => {
    it("is hidden when updateAvailable() is null", () => {
      render(() => <UpdateBanner />);
      expect(screen.queryByRole("status")).toBeNull();
      expect(getNotifications()).toHaveLength(0);
    });

    it("renders banner with Reload button and exact Changelog link when updateAvailable is set, and pushes app-update notification once", () => {
      render(() => <UpdateBanner />);

      _setUpdateAvailableForTests({
        version: "0.1.2",
        sha: "fedcba987654",
        builtAt: "2026-01-02T00:00:00.000Z",
      });

      const banner = screen.getByRole("status");
      expect(banner.textContent).toContain("A new version is available.");

      const changelogLink = screen.getByRole("link", { name: "Changelog" });
      expect(changelogLink.getAttribute("href")).toBe(
        "https://github.com/gordon-code/github-tracker/blob/main/CHANGELOG.md",
      );
      expect(changelogLink.getAttribute("target")).toBe("_blank");
      expect(changelogLink.getAttribute("rel")).toBe("noopener noreferrer");

      const notifs = getNotifications().filter((n) => n.source === "app-update");
      expect(notifs).toHaveLength(1);
      expect(notifs[0].severity).toBe("info");
      expect(notifs[0].message).toBe(
        "A new version of GitHub Tracker is available — reload to update.",
      );

      // Updating signal again must not duplicate or re-push the notification
      _setUpdateAvailableForTests({
        version: "0.1.3",
        sha: "111122223333",
        builtAt: "2026-01-03T00:00:00.000Z",
      });
      expect(getNotifications().filter((n) => n.source === "app-update")).toHaveLength(1);
    });

    it("hides the banner and dismisses the app-update notification when the update clears, then re-notifies if flagged again", () => {
      render(() => <UpdateBanner />);
      const info = {
        version: "0.1.2",
        sha: "fedcba987654",
        builtAt: "2026-01-02T00:00:00.000Z",
      };

      _setUpdateAvailableForTests(info);
      expect(screen.getByRole("status")).toBeDefined();
      expect(getNotifications().filter((n) => n.source === "app-update")).toHaveLength(1);

      _setUpdateAvailableForTests(null);
      expect(screen.queryByRole("status")).toBeNull();
      expect(getNotifications().filter((n) => n.source === "app-update")).toHaveLength(0);

      _setUpdateAvailableForTests(info);
      expect(screen.getByRole("status")).toBeDefined();
      expect(getNotifications().filter((n) => n.source === "app-update")).toHaveLength(1);
    });

    it("flushes pending config and viewState persistence before calling window.location.reload()", () => {
      let disposePersistence!: () => void;
      createRoot((d) => {
        disposePersistence = d;
        initConfigPersistence();
        initViewPersistence();
      });

      _setUpdateAvailableForTests({
        version: "0.1.2",
        sha: "fedcba987654",
        builtAt: "2026-01-02T00:00:00.000Z",
      });

      let configAtReload: string | null = null;
      let viewAtReload: string | null = null;
      reloadMock.mockImplementation(() => {
        configAtReload = localStorage.getItem(CONFIG_STORAGE_KEY);
        viewAtReload = localStorage.getItem(VIEW_STORAGE_KEY);
      });

      render(() => <UpdateBanner />);

      updateConfig({ theme: "forest", onboardingComplete: true });
      updateViewState({ lastActiveTab: "actions" });

      // Click Reload before the 200ms debounce timer fires
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));

      expect(reloadMock).toHaveBeenCalledTimes(1);
      expect(configAtReload).not.toBeNull();
      expect(viewAtReload).not.toBeNull();
      expect((JSON.parse(configAtReload!) as { theme: string }).theme).toBe("forest");
      expect((JSON.parse(viewAtReload!) as { lastActiveTab: string }).lastActiveTab).toBe(
        "actions",
      );

      disposePersistence();
    });
  });

  describe("UpdateNavigator", () => {
    function NavTestHarness() {
      const navigate = useNavigate();
      return (
        <div>
          <button type="button" onClick={() => navigate("/settings")}>
            Go Settings
          </button>
          <button type="button" onClick={() => navigate("/settings?tab=general#jira")}>
            Go Settings With Query And Hash
          </button>
          <button type="button" onClick={() => navigate("/?filter=open#top")}>
            Same Path Query Change
          </button>
          <button type="button" onClick={() => navigate("/dashboard")}>
            Go Dashboard
          </button>
        </div>
      );
    }

    it("does not call location.assign when navigating with updateAvailable null", async () => {
      const history = createMemoryHistory();
      render(() => (
        <MemoryRouter
          history={history}
          root={(props) => (
            <>
              <UpdateNavigator />
              {props.children}
            </>
          )}
        >
          <Route path="/" component={NavTestHarness} />
          <Route path="/settings" component={NavTestHarness} />
          <Route path="/dashboard" component={NavTestHarness} />
        </MemoryRouter>
      ));

      fireEvent.click(screen.getByRole("button", { name: "Go Settings" }));
      await Promise.resolve();
      expect(assignMock).not.toHaveBeenCalled();
    });

    it("flushes debounced config and viewState persistence and calls location.assign once per target SHA on navigation", async () => {
      let disposePersistence!: () => void;
      createRoot((d) => {
        disposePersistence = d;
        initConfigPersistence();
        initViewPersistence();
      });

      // Seed stale previous-identity values in localStorage
      localStorage.setItem(
        CONFIG_STORAGE_KEY,
        JSON.stringify({ theme: "corporate", onboardingComplete: false }),
      );
      localStorage.setItem(
        VIEW_STORAGE_KEY,
        JSON.stringify({ lastActiveTab: "issues" }),
      );

      let configAtAssign: string | null = null;
      let viewAtAssign: string | null = null;
      assignMock.mockImplementation(() => {
        configAtAssign = localStorage.getItem(CONFIG_STORAGE_KEY);
        viewAtAssign = localStorage.getItem(VIEW_STORAGE_KEY);
      });

      const history = createMemoryHistory();
      render(() => (
        <MemoryRouter
          history={history}
          root={(props) => (
            <>
              <UpdateNavigator />
              {props.children}
            </>
          )}
        >
          <Route path="/" component={NavTestHarness} />
          <Route path="/settings" component={NavTestHarness} />
          <Route path="/dashboard" component={NavTestHarness} />
        </MemoryRouter>
      ));

      _setUpdateAvailableForTests({
        version: "0.1.2",
        sha: "fedcba987654",
        builtAt: "2026-01-02T00:00:00.000Z",
      });

      // Simulate commitImportedSettings mutating config + viewState right before navigating
      updateConfig({ theme: "dracula", onboardingComplete: true });
      updateViewState({ lastActiveTab: "pullRequests" });

      // Navigate before the 200ms debounce timer elapses
      fireEvent.click(screen.getByRole("button", { name: "Go Settings" }));
      await Promise.resolve();

      expect(assignMock).toHaveBeenCalledTimes(1);
      expect(assignMock).toHaveBeenCalledWith("/settings");
      expect(configAtAssign).not.toBeNull();
      expect(viewAtAssign).not.toBeNull();
      expect((JSON.parse(configAtAssign!) as { theme: string }).theme).toBe("dracula");
      expect(
        (JSON.parse(configAtAssign!) as { onboardingComplete: boolean }).onboardingComplete,
      ).toBe(true);
      expect((JSON.parse(viewAtAssign!) as { lastActiveTab: string }).lastActiveTab).toBe(
        "pullRequests",
      );

      // Second navigation with the same target SHA must not trigger another assign
      fireEvent.click(screen.getByRole("button", { name: "Go Dashboard" }));
      await Promise.resolve();
      expect(assignMock).toHaveBeenCalledTimes(1);

      disposePersistence();
    });

    it("preserves location.search and location.hash when calling location.assign on pathname change and ignores same-path query/hash updates", async () => {
      const history = createMemoryHistory();
      render(() => (
        <MemoryRouter
          history={history}
          root={(props) => (
            <>
              <UpdateNavigator />
              {props.children}
            </>
          )}
        >
          <Route path="/" component={NavTestHarness} />
          <Route path="/settings" component={NavTestHarness} />
          <Route path="/dashboard" component={NavTestHarness} />
        </MemoryRouter>
      ));

      _setUpdateAvailableForTests({
        version: "0.1.2",
        sha: "fedcba987654",
        builtAt: "2026-01-02T00:00:00.000Z",
      });

      // Updating search/hash on the same pathname ("/") does not trigger location.assign
      fireEvent.click(screen.getByRole("button", { name: "Same Path Query Change" }));
      await Promise.resolve();
      expect(assignMock).not.toHaveBeenCalled();

      // Navigating to a new pathname with search and hash passes full path + search + hash
      fireEvent.click(screen.getByRole("button", { name: "Go Settings With Query And Hash" }));
      await Promise.resolve();
      expect(assignMock).toHaveBeenCalledTimes(1);
      expect(assignMock).toHaveBeenCalledWith("/settings?tab=general#jira");
    });
  });
});

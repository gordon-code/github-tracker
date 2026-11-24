import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { createRoot } from "solid-js";
import UpdateBanner from "../../../src/app/components/shared/UpdateBanner";
import {
  _setUpdateAvailableForTests,
  _setSchemaStaleForTests,
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

describe("UpdateBanner", () => {
  const originalLocation = window.location;
  let reloadMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    localStorage.clear();
    _resetVersionStateForTests();
    resetNotificationState();
    resetConfig();
    resetViewState();

    reloadMock = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        reload: reloadMock,
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

  describe("banner and app-update notification", () => {
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
      // The banner already announces the update, so the notification must not also toast.
      expect(notifs[0].silentToast).toBe(true);

      // Updating signal again must not duplicate or re-push the notification
      _setUpdateAvailableForTests({
        version: "0.1.3",
        sha: "111122223333",
        builtAt: "2026-01-03T00:00:00.000Z",
      });
      expect(getNotifications().filter((n) => n.source === "app-update")).toHaveLength(1);
    });

    it("says Settings are read-only only while the stored-data schema is stale", () => {
      render(() => <UpdateBanner />);
      _setUpdateAvailableForTests({
        version: "0.1.2",
        sha: "fedcba987654",
        builtAt: "2026-01-02T00:00:00.000Z",
      });
      const banner = screen.getByRole("status");
      expect(banner.textContent).not.toContain("read-only");

      _setSchemaStaleForTests(true);
      expect(banner.textContent).toContain("A new version is available.");
      expect(banner.textContent).toContain(
        "This tab can't save changes, and Settings are read-only, until you reload.",
      );

      _setSchemaStaleForTests(false);
      expect(banner.textContent).not.toContain("read-only");
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
      const renotified = getNotifications().filter((n) => n.source === "app-update");
      expect(renotified).toHaveLength(1);
      expect(renotified[0].silentToast).toBe(true);
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
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import {
  MemoryRouter,
  Route,
  useNavigate,
  useLocation,
  createMemoryHistory,
  type MemoryHistory,
} from "@solidjs/router";
import { createRoot } from "solid-js";
import UpdateNavigator from "../../../src/app/components/shared/UpdateNavigator";
import {
  _setUpdateAvailableForTests,
  _resetVersionStateForTests,
} from "../../../src/app/lib/version";
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

const UPDATE_INFO = {
  version: "0.1.2",
  sha: "fedcba987654",
  builtAt: "2026-01-02T00:00:00.000Z",
};

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

function PathnameProbe() {
  const location = useLocation();
  return <span data-testid="router-pathname">{location.pathname}</span>;
}

function renderWithNavigator(history: MemoryHistory) {
  render(() => (
    <MemoryRouter
      history={history}
      root={(props) => (
        <>
          <UpdateNavigator />
          <PathnameProbe />
          {props.children}
        </>
      )}
    >
      <Route path="/" component={NavTestHarness} />
      <Route path="/settings" component={NavTestHarness} />
      <Route path="/dashboard" component={NavTestHarness} />
    </MemoryRouter>
  ));
}

describe("UpdateNavigator", () => {
  const originalLocation = window.location;
  let assignMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    localStorage.clear();
    _resetVersionStateForTests();
    resetConfig();
    resetViewState();

    assignMock = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        reload: vi.fn(),
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
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
    vi.useRealTimers();
  });

  it("navigates in-app without calling location.assign when updateAvailable is null", async () => {
    const history = createMemoryHistory();
    renderWithNavigator(history);
    expect(screen.getByTestId("router-pathname").textContent).toBe("/");

    fireEvent.click(screen.getByRole("button", { name: "Go Settings" }));
    await Promise.resolve();

    expect(screen.getByTestId("router-pathname").textContent).toBe("/settings");
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("flushes debounced config and viewState persistence and calls location.assign once per target SHA on navigation", async () => {
    let disposePersistence!: () => void;
    createRoot((d) => {
      disposePersistence = d;
      initConfigPersistence();
      initViewPersistence();
    });

    // Seed on-disk values that differ from the pending in-memory changes
    localStorage.setItem(
      CONFIG_STORAGE_KEY,
      JSON.stringify({ theme: "corporate", onboardingComplete: false }),
    );
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({ lastActiveTab: "issues" }));

    let configAtAssign: string | null = null;
    let viewAtAssign: string | null = null;
    assignMock.mockImplementation(() => {
      configAtAssign = localStorage.getItem(CONFIG_STORAGE_KEY);
      viewAtAssign = localStorage.getItem(VIEW_STORAGE_KEY);
    });

    renderWithNavigator(createMemoryHistory());
    _setUpdateAvailableForTests(UPDATE_INFO);

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
    renderWithNavigator(createMemoryHistory());
    _setUpdateAvailableForTests(UPDATE_INFO);

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

  it("skips the reload for a protocol-relative pathname without consuming the per-target reload", async () => {
    const history = createMemoryHistory();
    renderWithNavigator(history);
    _setUpdateAvailableForTests(UPDATE_INFO);

    history.set({ value: "//evil.example/x" });
    await Promise.resolve();
    expect(screen.getByTestId("router-pathname").textContent).toBe("//evil.example/x");
    expect(assignMock).not.toHaveBeenCalled();

    // The next same-origin pathname change still performs the once-per-target reload
    history.set({ value: "/settings" });
    await Promise.resolve();
    expect(assignMock).toHaveBeenCalledTimes(1);
    expect(assignMock).toHaveBeenCalledWith("/settings");
  });
});

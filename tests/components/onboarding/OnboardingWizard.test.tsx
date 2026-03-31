import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import type { RepoRef, OrgEntry } from "../../../src/app/services/api";

// Mock fetchOrgs and getClient
vi.mock("../../../src/app/services/api", () => ({
  fetchOrgs: vi.fn(),
}));
vi.mock("../../../src/app/services/github", () => ({
  getClient: vi.fn(() => ({})),
}));

// Mock RepoSelector to avoid internal fetching
vi.mock("../../../src/app/components/onboarding/RepoSelector", () => ({
  default: (props: {
    selectedOrgs: string[];
    orgEntries?: OrgEntry[];
    selected: RepoRef[];
    onChange: (s: RepoRef[]) => void;
    monitoredRepos?: RepoRef[];
    onMonitorToggle?: (repo: RepoRef, monitored: boolean) => void;
  }) => (
    <div data-testid="repo-selector">
      <span data-testid="repo-selector-orgs">
        {props.selectedOrgs.join(",")}
      </span>
      <button
        onClick={() =>
          props.onChange([
            { owner: "myorg", name: "myrepo", fullName: "myorg/myrepo" },
          ])
        }
      >
        Select Repo
      </button>
      <button
        onClick={() =>
          props.onMonitorToggle?.(
            { owner: "myorg", name: "myrepo", fullName: "myorg/myrepo" },
            true
          )
        }
      >
        Toggle Monitor
      </button>
      <span>Repos: {props.selected.length}</span>
      <span data-testid="monitored-count">Monitored: {(props.monitoredRepos ?? []).length}</span>
    </div>
  ),
}));

// Mock LoadingSpinner
vi.mock("../../../src/app/components/shared/LoadingSpinner", () => ({
  default: (props: { label?: string }) => (
    <div data-testid="loading-spinner">{props.label ?? "Loading..."}</div>
  ),
}));

// Mock config store
vi.mock("../../../src/app/stores/config", () => ({
  CONFIG_STORAGE_KEY: "github-tracker:config",
  config: { selectedOrgs: [], selectedRepos: [], upstreamRepos: [], monitoredRepos: [], trackedUsers: [] },
  updateConfig: vi.fn(),
}));

import * as configStore from "../../../src/app/stores/config";
import * as apiModule from "../../../src/app/services/api";
import OnboardingWizard from "../../../src/app/components/onboarding/OnboardingWizard";

const mockOrgs: OrgEntry[] = [
  { login: "myorg", avatarUrl: "", type: "org" },
  { login: "otherog", avatarUrl: "", type: "org" },
];

describe("OnboardingWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { replace: vi.fn(), href: "" },
    });
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      writable: true,
      value: {
        setItem: vi.fn(),
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
        clear: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders "GitHub Tracker Setup" heading', async () => {
    vi.mocked(apiModule.fetchOrgs).mockResolvedValue(mockOrgs);
    render(() => <OnboardingWizard />);
    screen.getByText("GitHub Tracker Setup");
  });

  it('renders "Select the repositories you want to track" subtitle', async () => {
    vi.mocked(apiModule.fetchOrgs).mockResolvedValue(mockOrgs);
    render(() => <OnboardingWizard />);
    screen.getByText("Select the repositories you want to track.");
  });

  it("does NOT render OrgSelector or step indicator", async () => {
    vi.mocked(apiModule.fetchOrgs).mockResolvedValue(mockOrgs);
    render(() => <OnboardingWizard />);
    expect(screen.queryByTestId("org-selector")).toBeNull();
    expect(screen.queryByText(/Step \d of \d/i)).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: /progress/i })
    ).toBeNull();
  });

  it("shows loading spinner while fetching orgs", async () => {
    vi.mocked(apiModule.fetchOrgs).mockReturnValue(new Promise(() => {}));
    render(() => <OnboardingWizard />);
    await waitFor(() => {
      screen.getByTestId("loading-spinner");
    });
  });

  it("redirects to /dashboard when onboardingComplete is already true", async () => {
    Object.assign(configStore.config, { onboardingComplete: true });
    render(() => <OnboardingWizard />);
    await waitFor(() => {
      expect(window.location.replace).toHaveBeenCalledWith("/dashboard");
    });
    expect(apiModule.fetchOrgs).not.toHaveBeenCalled();
    Object.assign(configStore.config, { onboardingComplete: false });
  });

  it("retry clears error and shows RepoSelector on success", async () => {
    const user = userEvent.setup();
    vi.mocked(apiModule.fetchOrgs)
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce(mockOrgs);
    render(() => <OnboardingWizard />);
    await waitFor(() => {
      screen.getByText("Retry");
    });
    await user.click(screen.getByText("Retry"));
    await waitFor(() => {
      screen.getByTestId("repo-selector");
    });
    expect(screen.queryByText(/Network error/i)).toBeNull();
  });

  it("shows error when getClient returns null", async () => {
    const { getClient } = await import("../../../src/app/services/github");
    vi.mocked(getClient).mockReturnValueOnce(null);
    render(() => <OnboardingWizard />);
    await waitFor(() => {
      screen.getByText(/No GitHub client available/i);
    });
  });

  it("shows error state with retry button when fetchOrgs fails", async () => {
    vi.mocked(apiModule.fetchOrgs).mockRejectedValue(
      new Error("Network error")
    );
    render(() => <OnboardingWizard />);
    await waitFor(() => {
      screen.getByText(/Network error/i);
      screen.getByText("Retry");
    });
  });

  it("renders RepoSelector with all fetched org logins once loaded", async () => {
    vi.mocked(apiModule.fetchOrgs).mockResolvedValue(mockOrgs);
    render(() => <OnboardingWizard />);
    await waitFor(() => {
      const orgsSpan = screen.getByTestId("repo-selector-orgs");
      expect(orgsSpan.textContent).toBe("myorg,otherog");
    });
  });

  it('"Finish Setup" button is disabled when no repos are selected', async () => {
    vi.mocked(apiModule.fetchOrgs).mockResolvedValue(mockOrgs);
    render(() => <OnboardingWizard />);
    await waitFor(() => {
      screen.getByTestId("repo-selector");
    });
    const btn = screen.getByText("Finish Setup");
    expect(btn.hasAttribute("disabled")).toBe(true);
  });

  it('"Finish Setup" button shows selected repo count', async () => {
    const user = userEvent.setup();
    vi.mocked(apiModule.fetchOrgs).mockResolvedValue(mockOrgs);
    render(() => <OnboardingWizard />);
    await waitFor(() => {
      screen.getByTestId("repo-selector");
    });
    await user.click(screen.getByText("Select Repo"));
    await waitFor(() => {
      screen.getByText(/Finish Setup \(1 repo\)/);
    });
  });

  it("on finish: selectedOrgs is derived from unique repo owners", async () => {
    const user = userEvent.setup();
    vi.mocked(apiModule.fetchOrgs).mockResolvedValue(mockOrgs);
    render(() => <OnboardingWizard />);
    await waitFor(() => {
      screen.getByTestId("repo-selector");
    });
    await user.click(screen.getByText("Select Repo"));
    await waitFor(() => {
      screen.getByText(/Finish Setup \(1 repo\)/);
    });
    await user.click(screen.getByText(/Finish Setup \(1 repo\)/));
    expect(vi.mocked(configStore.updateConfig)).toHaveBeenCalledWith(
      expect.objectContaining({ selectedOrgs: ["myorg"] })
    );
  });

  it("on finish: onboardingComplete is set to true", async () => {
    const user = userEvent.setup();
    vi.mocked(apiModule.fetchOrgs).mockResolvedValue(mockOrgs);
    render(() => <OnboardingWizard />);
    await waitFor(() => {
      screen.getByTestId("repo-selector");
    });
    await user.click(screen.getByText("Select Repo"));
    await waitFor(() => {
      screen.getByText(/Finish Setup \(1 repo\)/);
    });
    await user.click(screen.getByText(/Finish Setup \(1 repo\)/));
    expect(vi.mocked(configStore.updateConfig)).toHaveBeenCalledWith(
      expect.objectContaining({ onboardingComplete: true })
    );
  });

  it("on finish: flushes config to localStorage", async () => {
    const user = userEvent.setup();
    vi.mocked(apiModule.fetchOrgs).mockResolvedValue(mockOrgs);
    render(() => <OnboardingWizard />);
    await waitFor(() => {
      screen.getByTestId("repo-selector");
    });
    await user.click(screen.getByText("Select Repo"));
    await waitFor(() => {
      screen.getByText(/Finish Setup \(1 repo\)/);
    });
    await user.click(screen.getByText(/Finish Setup \(1 repo\)/));
    expect(localStorage.setItem).toHaveBeenCalledWith(
      "github-tracker:config",
      expect.any(String)
    );
  });

  it("on finish: navigates to /dashboard via window.location.replace", async () => {
    const user = userEvent.setup();
    vi.mocked(apiModule.fetchOrgs).mockResolvedValue(mockOrgs);
    render(() => <OnboardingWizard />);
    await waitFor(() => {
      screen.getByTestId("repo-selector");
    });
    await user.click(screen.getByText("Select Repo"));
    await waitFor(() => {
      screen.getByText(/Finish Setup \(1 repo\)/);
    });
    await user.click(screen.getByText(/Finish Setup \(1 repo\)/));
    expect(window.location.replace).toHaveBeenCalledWith("/dashboard");
  });

  it("passes monitoredRepos to updateConfig on finish (C4)", async () => {
    const user = userEvent.setup();
    vi.mocked(apiModule.fetchOrgs).mockResolvedValue(mockOrgs);
    render(() => <OnboardingWizard />);

    await waitFor(() => screen.getByTestId("repo-selector"));

    // Select a repo first
    await user.click(screen.getByText("Select Repo"));
    // Toggle monitor for that repo
    await user.click(screen.getByText("Toggle Monitor"));

    await waitFor(() => screen.getByText(/Finish Setup \(1 repo\)/));
    await user.click(screen.getByText(/Finish Setup \(1 repo\)/));

    expect(configStore.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        monitoredRepos: [{ owner: "myorg", name: "myrepo", fullName: "myorg/myrepo" }],
        selectedRepos: [{ owner: "myorg", name: "myrepo", fullName: "myorg/myrepo" }],
      })
    );
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import type { RepoRef } from "../../../src/app/services/api";

// Mock OrgSelector and RepoSelector to avoid their internal fetching
vi.mock("../../../src/app/components/onboarding/OrgSelector", () => ({
  default: (props: { selected: string[]; onChange: (s: string[]) => void }) => (
    <div data-testid="org-selector">
      <button onClick={() => props.onChange(["myorg"])}>Select Org</button>
      <span>Selected: {props.selected.join(",")}</span>
    </div>
  ),
}));

vi.mock("../../../src/app/components/onboarding/RepoSelector", () => ({
  default: (props: {
    selectedOrgs: string[];
    selected: RepoRef[];
    onChange: (s: RepoRef[]) => void;
  }) => (
    <div data-testid="repo-selector">
      <button
        onClick={() =>
          props.onChange([{ owner: "myorg", name: "myrepo", fullName: "myorg/myrepo" }])
        }
      >
        Select Repo
      </button>
      <span>Repos: {props.selected.length}</span>
    </div>
  ),
}));

// Mock config store
vi.mock("../../../src/app/stores/config", () => ({
  config: { selectedOrgs: [], selectedRepos: [] },
  updateConfig: vi.fn(),
}));

import * as configStore from "../../../src/app/stores/config";
import OnboardingWizard from "../../../src/app/components/onboarding/OnboardingWizard";

describe("OnboardingWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { replace: vi.fn(), href: "" },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders wizard with step indicator", () => {
    render(() => <OnboardingWizard />);
    screen.getByText("GitHub Tracker Setup");
    screen.getByText(/Step 1 of 2/i);
  });

  it("first step shows OrgSelector", () => {
    render(() => <OnboardingWizard />);
    screen.getByTestId("org-selector");
  });

  it("shows Select Organizations step label in progress indicator", () => {
    render(() => <OnboardingWizard />);
    // Text appears twice (step indicator + section heading): use getAllByText
    const matches = screen.getAllByText("Select Organizations");
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("Next button is disabled when no orgs selected", () => {
    render(() => <OnboardingWizard />);
    const nextButton = screen.getByText("Next");
    expect(nextButton.hasAttribute("disabled")).toBe(true);
  });

  it("Next button enables after org selection", async () => {
    render(() => <OnboardingWizard />);
    fireEvent.click(screen.getByText("Select Org"));

    await waitFor(() => {
      const nextButton = screen.getByText("Next");
      expect(nextButton.hasAttribute("disabled")).toBe(false);
    });
  });

  it("clicking Next advances to step 2", async () => {
    render(() => <OnboardingWizard />);
    fireEvent.click(screen.getByText("Select Org"));

    await waitFor(() => {
      expect(screen.getByText("Next").hasAttribute("disabled")).toBe(false);
    });

    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => {
      screen.getByText(/Step 2 of 2/i);
      screen.getByTestId("repo-selector");
    });
  });

  it("calls updateConfig with selected orgs on Next", async () => {
    render(() => <OnboardingWizard />);
    fireEvent.click(screen.getByText("Select Org"));

    await waitFor(() => {
      expect(screen.getByText("Next").hasAttribute("disabled")).toBe(false);
    });

    fireEvent.click(screen.getByText("Next"));

    expect(vi.mocked(configStore.updateConfig)).toHaveBeenCalledWith(
      expect.objectContaining({ selectedOrgs: ["myorg"] })
    );
  });

  it("Back button visible on step 2", async () => {
    render(() => <OnboardingWizard />);
    fireEvent.click(screen.getByText("Select Org"));

    await waitFor(() => {
      expect(screen.getByText("Next").hasAttribute("disabled")).toBe(false);
    });

    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => {
      screen.getByText("Back");
    });
  });

  it("clicking Back returns to step 1", async () => {
    render(() => <OnboardingWizard />);
    fireEvent.click(screen.getByText("Select Org"));

    await waitFor(() => {
      expect(screen.getByText("Next").hasAttribute("disabled")).toBe(false);
    });

    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => {
      screen.getByText("Back");
    });

    fireEvent.click(screen.getByText("Back"));

    await waitFor(() => {
      screen.getByTestId("org-selector");
      screen.getByText(/Step 1 of 2/i);
    });
  });

  it("Finish Setup button disabled when no repos selected", async () => {
    render(() => <OnboardingWizard />);
    fireEvent.click(screen.getByText("Select Org"));

    await waitFor(() => {
      expect(screen.getByText("Next").hasAttribute("disabled")).toBe(false);
    });

    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => {
      const finishButton = screen.getByText("Finish Setup");
      expect(finishButton.hasAttribute("disabled")).toBe(true);
    });
  });

  it("completing final step calls updateConfig and window.location.replace", async () => {
    render(() => <OnboardingWizard />);

    // Step 1: select org, advance
    fireEvent.click(screen.getByText("Select Org"));
    await waitFor(() => {
      expect(screen.getByText("Next").hasAttribute("disabled")).toBe(false);
    });
    fireEvent.click(screen.getByText("Next"));

    // Step 2: select repo, finish
    await waitFor(() => {
      screen.getByTestId("repo-selector");
    });
    fireEvent.click(screen.getByText("Select Repo"));

    await waitFor(() => {
      const finishBtn = screen.queryByText(/Finish Setup \(1 repo\)/);
      expect(finishBtn).toBeDefined();
      expect(finishBtn?.hasAttribute("disabled")).toBe(false);
    });

    fireEvent.click(screen.getByText(/Finish Setup \(1 repo\)/));

    expect(vi.mocked(configStore.updateConfig)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedRepos: [{ owner: "myorg", name: "myrepo", fullName: "myorg/myrepo" }],
        onboardingComplete: true,
      })
    );
    expect(window.location.replace).toHaveBeenCalledWith("/dashboard");
  });
});

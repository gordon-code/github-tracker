import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import type { RepoRef } from "../../../src/app/services/api";

// Mock getClient before importing component
vi.mock("../../../src/app/services/github", () => ({
  getClient: () => ({}),
}));

// Mock api module functions
vi.mock("../../../src/app/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/app/services/api")>();
  return {
    ...actual,
    fetchOrgs: vi.fn().mockResolvedValue([
      { login: "myorg", avatarUrl: "", type: "org" },
      { login: "otherog", avatarUrl: "", type: "org" },
    ]),
    fetchRepos: vi.fn(),
  };
});

import * as api from "../../../src/app/services/api";
import RepoSelector from "../../../src/app/components/onboarding/RepoSelector";

const myorgRepos: RepoRef[] = [
  { owner: "myorg", name: "repo-a", fullName: "myorg/repo-a" },
  { owner: "myorg", name: "repo-b", fullName: "myorg/repo-b" },
];

const otherorgRepos: RepoRef[] = [
  { owner: "otherog", name: "repo-c", fullName: "otherog/repo-c" },
];

describe("RepoSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading while fetching repos", async () => {
    vi.mocked(api.fetchRepos).mockReturnValue(new Promise(() => {}));
    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={[]} onChange={vi.fn()} />
    ));
    // Loading indicator should appear
    await waitFor(() => {
      expect(screen.getByText(/Loading repos/i)).toBeDefined();
    });
  });

  it("renders repos grouped by org", async () => {
    vi.mocked(api.fetchRepos).mockImplementation((_client, org) => {
      if (org === "myorg") return Promise.resolve(myorgRepos);
      return Promise.resolve(otherorgRepos);
    });

    render(() => (
      <RepoSelector selectedOrgs={["myorg", "otherog"]} selected={[]} onChange={vi.fn()} />
    ));

    await waitFor(() => {
      expect(screen.getByText("repo-a")).toBeDefined();
      expect(screen.getByText("repo-b")).toBeDefined();
      expect(screen.getByText("repo-c")).toBeDefined();
    });

    // Org headers shown
    expect(screen.getByText("myorg")).toBeDefined();
    expect(screen.getByText("otherog")).toBeDefined();
  });

  it("onChange called when repo toggled", async () => {
    vi.mocked(api.fetchRepos).mockResolvedValue(myorgRepos);
    const onChange = vi.fn();

    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={[]} onChange={onChange} />
    ));

    await waitFor(() => {
      expect(screen.getByText("repo-a")).toBeDefined();
    });

    const checkboxes = screen.getAllByRole("checkbox");
    const repoACheckbox = checkboxes.find((cb) => {
      const label = cb.closest("label");
      return label?.textContent?.includes("repo-a");
    });

    fireEvent.click(repoACheckbox!);
    expect(onChange).toHaveBeenCalledWith([myorgRepos[0]]);
  });

  it("filters repos by text input", async () => {
    vi.mocked(api.fetchRepos).mockResolvedValue(myorgRepos);

    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={[]} onChange={vi.fn()} />
    ));

    await waitFor(() => {
      expect(screen.getByText("repo-a")).toBeDefined();
    });

    const filterInput = screen.getByPlaceholderText(/Filter repos/i);
    fireEvent.input(filterInput, { target: { value: "repo-a" } });

    await waitFor(() => {
      expect(screen.getByText("repo-a")).toBeDefined();
      expect(screen.queryByText("repo-b")).toBeNull();
    });
  });

  it("per-org Select All selects all repos in that org", async () => {
    vi.mocked(api.fetchRepos).mockResolvedValue(myorgRepos);
    const onChange = vi.fn();

    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={[]} onChange={onChange} />
    ));

    await waitFor(() => {
      expect(screen.getByText("repo-a")).toBeDefined();
    });

    // "Select All" button in the org header (there may be multiple — use the first one)
    const selectAllBtns = screen.getAllByText("Select All");
    // The per-org one is inside the org group; for a single org there's only one
    fireEvent.click(selectAllBtns[selectAllBtns.length - 1]);

    expect(onChange).toHaveBeenCalled();
    const result = onChange.mock.calls[0][0] as RepoRef[];
    expect(result.map((r) => r.fullName)).toContain("myorg/repo-a");
    expect(result.map((r) => r.fullName)).toContain("myorg/repo-b");
  });

  it("per-org Deselect All deselects all repos in that org", async () => {
    vi.mocked(api.fetchRepos).mockResolvedValue(myorgRepos);
    const onChange = vi.fn();

    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={myorgRepos} onChange={onChange} />
    ));

    await waitFor(() => {
      expect(screen.getByText("repo-a")).toBeDefined();
    });

    const deselectAllBtns = screen.getAllByText("Deselect All");
    fireEvent.click(deselectAllBtns[deselectAllBtns.length - 1]);

    expect(onChange).toHaveBeenCalled();
    const result = onChange.mock.calls[0][0] as RepoRef[];
    expect(result.map((r) => r.fullName)).not.toContain("myorg/repo-a");
    expect(result.map((r) => r.fullName)).not.toContain("myorg/repo-b");
  });

  it("shows error and retry button on fetch failure", async () => {
    vi.mocked(api.fetchRepos).mockRejectedValue(new Error("Network error"));

    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={[]} onChange={vi.fn()} />
    ));

    await waitFor(() => {
      expect(screen.getByText(/Network error/i)).toBeDefined();
      expect(screen.getByText("Retry")).toBeDefined();
    });
  });

  it("clicking Retry re-fetches repos for that org", async () => {
    vi.mocked(api.fetchRepos)
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce(myorgRepos);

    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={[]} onChange={vi.fn()} />
    ));

    await waitFor(() => {
      expect(screen.getByText("Retry")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Retry"));

    await waitFor(() => {
      expect(screen.getByText("repo-a")).toBeDefined();
    });
  });

  it("shows selected repo count", async () => {
    vi.mocked(api.fetchRepos).mockResolvedValue(myorgRepos);

    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={myorgRepos} onChange={vi.fn()} />
    ));

    await waitFor(() => {
      expect(screen.getByText(/2 repos selected/i)).toBeDefined();
    });
  });
});

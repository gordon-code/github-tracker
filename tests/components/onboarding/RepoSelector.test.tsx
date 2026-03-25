import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import type { RepoRef, RepoEntry } from "../../../src/app/services/api";

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
      { login: "stale-org", avatarUrl: "", type: "org" },
      { login: "active-org", avatarUrl: "", type: "org" },
    ]),
    fetchRepos: vi.fn(),
  };
});

import * as api from "../../../src/app/services/api";
import RepoSelector from "../../../src/app/components/onboarding/RepoSelector";

const myorgRepos: RepoEntry[] = [
  { owner: "myorg", name: "repo-a", fullName: "myorg/repo-a", pushedAt: "2026-03-20T10:00:00Z" },
  { owner: "myorg", name: "repo-b", fullName: "myorg/repo-b", pushedAt: "2026-03-22T10:00:00Z" },
];

const otherorgRepos: RepoEntry[] = [
  { owner: "otherog", name: "repo-c", fullName: "otherog/repo-c", pushedAt: "2026-03-10T10:00:00Z" },
];

describe("RepoSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("shows loading while fetching repos", async () => {
    vi.mocked(api.fetchRepos).mockReturnValue(new Promise(() => {}));
    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={[]} onChange={vi.fn()} />
    ));
    // Loading indicator should appear
    await waitFor(() => {
      screen.getByText(/Loading repos/i);
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
      screen.getByText("repo-a");
      screen.getByText("repo-b");
      screen.getByText("repo-c");
    });

    // Org headers shown
    screen.getByText("myorg");
    screen.getByText("otherog");
  });

  it("onChange called when repo toggled", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchRepos).mockResolvedValue(myorgRepos);
    const onChange = vi.fn();

    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={[]} onChange={onChange} />
    ));

    await waitFor(() => {
      screen.getByText("repo-a");
    });

    const checkboxes = screen.getAllByRole("checkbox");
    const repoACheckbox = checkboxes.find((cb) => {
      const label = cb.closest("label");
      return label?.textContent?.includes("repo-a");
    });

    await user.click(repoACheckbox!);
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ owner: "myorg", name: "repo-a", fullName: "myorg/repo-a" }),
    ]);
    const result = onChange.mock.calls[0][0] as RepoRef[];
    expect(result[0]).not.toHaveProperty("pushedAt");
  });

  it("filters repos by text input", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchRepos).mockResolvedValue(myorgRepos);

    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={[]} onChange={vi.fn()} />
    ));

    await waitFor(() => {
      screen.getByText("repo-a");
    });

    const filterInput = screen.getByPlaceholderText(/Filter repos/i);
    await user.type(filterInput, "repo-a");

    await waitFor(() => {
      screen.getByText("repo-a");
      expect(screen.queryByText("repo-b")).toBeNull();
    });
  });

  it("per-org Select All selects all repos in that org", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchRepos).mockResolvedValue(myorgRepos);
    const onChange = vi.fn();

    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={[]} onChange={onChange} />
    ));

    await waitFor(() => {
      screen.getByText("repo-a");
    });

    // With a single org: [global Select All, per-org Select All] — click the per-org (last) one
    const selectAllBtns = screen.getAllByText("Select All");
    await user.click(selectAllBtns[selectAllBtns.length - 1]);

    expect(onChange).toHaveBeenCalled();
    const result = onChange.mock.calls[0][0] as RepoRef[];
    expect(result.map((r) => r.fullName)).toContain("myorg/repo-a");
    expect(result.map((r) => r.fullName)).toContain("myorg/repo-b");
    for (const r of result) {
      expect(r).not.toHaveProperty("pushedAt");
    }
  });

  it("per-org Deselect All deselects all repos in that org", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchRepos).mockResolvedValue(myorgRepos);
    const onChange = vi.fn();

    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={myorgRepos.map((r) => ({ owner: r.owner, name: r.name, fullName: r.fullName }))} onChange={onChange} />
    ));

    await waitFor(() => {
      screen.getByText("repo-a");
    });

    const deselectAllBtns = screen.getAllByText("Deselect All");
    await user.click(deselectAllBtns[deselectAllBtns.length - 1]);

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
      screen.getByText(/Network error/i);
      screen.getByText("Retry");
    });
  });

  it("clicking Retry re-fetches repos for that org", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchRepos)
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce(myorgRepos);

    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={[]} onChange={vi.fn()} />
    ));

    await waitFor(() => {
      screen.getByText("Retry");
    });

    await user.click(screen.getByText("Retry"));

    await waitFor(() => {
      screen.getByText("repo-a");
    });
  });

  it("shows selected repo count", async () => {
    vi.mocked(api.fetchRepos).mockResolvedValue(myorgRepos);

    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={myorgRepos.map((r) => ({ owner: r.owner, name: r.name, fullName: r.fullName }))} onChange={vi.fn()} />
    ));

    await waitFor(() => {
      screen.getByText(/2 repos selected/i);
    });
  });

  it("shows relative time next to each repo", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-03-24T12:00:00Z").getTime());
    vi.mocked(api.fetchRepos).mockResolvedValue(myorgRepos);
    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={[]} onChange={vi.fn()} />
    ));
    await waitFor(() => {
      screen.getByText("4 days ago");
      screen.getByText("2 days ago");
    });
  });

  it("sorts org groups by most recent activity", async () => {
    const staleRepos: RepoEntry[] = [
      { owner: "stale-org", name: "old-repo", fullName: "stale-org/old-repo", pushedAt: "2025-01-01T00:00:00Z" },
    ];
    const activeRepos: RepoEntry[] = [
      { owner: "active-org", name: "new-repo", fullName: "active-org/new-repo", pushedAt: "2026-03-23T00:00:00Z" },
    ];
    vi.mocked(api.fetchRepos).mockImplementation((_client, org) => {
      if (org === "stale-org") return Promise.resolve(staleRepos);
      return Promise.resolve(activeRepos);
    });
    render(() => (
      <RepoSelector selectedOrgs={["stale-org", "active-org"]} selected={[]} onChange={vi.fn()} />
    ));
    await waitFor(() => {
      screen.getByText("old-repo");
      screen.getByText("new-repo");
    });
    const orgHeaders = screen.getAllByText(/^(active-org|stale-org)$/);
    expect(orgHeaders[0].textContent).toBe("active-org");
    expect(orgHeaders[1].textContent).toBe("stale-org");
  });

  it("does not show timestamp for repos with null pushedAt", async () => {
    const reposWithNull: RepoEntry[] = [
      { owner: "myorg", name: "empty-repo", fullName: "myorg/empty-repo", pushedAt: null },
    ];
    vi.mocked(api.fetchRepos).mockResolvedValue(reposWithNull);
    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={[]} onChange={vi.fn()} />
    ));
    await waitFor(() => {
      screen.getByText("empty-repo");
    });
    expect(screen.queryByText(/ago|yesterday|just now|last/i)).toBeNull();
  });

  it("global Select All strips pushedAt from onChange payload", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchRepos).mockImplementation((_client, org) => {
      if (org === "myorg") return Promise.resolve(myorgRepos);
      return Promise.resolve(otherorgRepos);
    });
    const onChange = vi.fn();
    render(() => (
      <RepoSelector selectedOrgs={["myorg", "otherog"]} selected={[]} onChange={onChange} />
    ));
    await waitFor(() => {
      screen.getByText("repo-a");
      screen.getByText("repo-c");
    });
    // The first "Select All" button is the global one in the header
    const selectAllBtns = screen.getAllByText("Select All");
    await user.click(selectAllBtns[0]);
    expect(onChange).toHaveBeenCalled();
    const result = onChange.mock.calls[0][0] as RepoRef[];
    expect(result.length).toBe(3);
    for (const r of result) {
      expect(r).not.toHaveProperty("pushedAt");
    }
  });

  it("preserves org order when all repos have null pushedAt", async () => {
    const nullOrg1: RepoEntry[] = [
      { owner: "stale-org", name: "null-repo-1", fullName: "stale-org/null-repo-1", pushedAt: null },
    ];
    const nullOrg2: RepoEntry[] = [
      { owner: "active-org", name: "null-repo-2", fullName: "active-org/null-repo-2", pushedAt: null },
    ];
    vi.mocked(api.fetchRepos).mockImplementation((_client, org) => {
      if (org === "stale-org") return Promise.resolve(nullOrg1);
      return Promise.resolve(nullOrg2);
    });
    render(() => (
      <RepoSelector selectedOrgs={["stale-org", "active-org"]} selected={[]} onChange={vi.fn()} />
    ));
    await waitFor(() => {
      screen.getByText("null-repo-1");
      screen.getByText("null-repo-2");
    });
    const orgHeaders = screen.getAllByText(/^(active-org|stale-org)$/);
    // Both have null pushedAt → comparator returns 0 → original order preserved
    expect(orgHeaders[0].textContent).toBe("stale-org");
    expect(orgHeaders[1].textContent).toBe("active-org");
  });

  it("each org group has a scrollable region with aria-label", async () => {
    vi.mocked(api.fetchRepos).mockImplementation((_client, org) => {
      if (org === "myorg") return Promise.resolve(myorgRepos);
      return Promise.resolve(otherorgRepos);
    });
    render(() => (
      <RepoSelector selectedOrgs={["myorg", "otherog"]} selected={[]} onChange={vi.fn()} />
    ));
    await waitFor(() => {
      screen.getByText("repo-a");
      screen.getByText("repo-c");
    });
    screen.getByRole("region", { name: "myorg repositories" });
    screen.getByRole("region", { name: "otherog repositories" });
  });

  it("scroll container has max-h-[300px] and overflow-y-auto classes", async () => {
    vi.mocked(api.fetchRepos).mockResolvedValue(myorgRepos);
    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={[]} onChange={vi.fn()} />
    ));
    await waitFor(() => {
      screen.getByText("repo-a");
    });
    const scrollContainer = screen.getByRole("region", { name: "myorg repositories" });
    expect(scrollContainer.classList.contains("max-h-[300px]")).toBe(true);
    expect(scrollContainer.classList.contains("overflow-y-auto")).toBe(true);
  });

  it("skips internal fetchOrgs when orgEntries prop is provided", async () => {
    vi.mocked(api.fetchOrgs).mockClear();
    vi.mocked(api.fetchRepos).mockResolvedValue(myorgRepos);
    const preloaded = [
      { login: "myorg", avatarUrl: "", type: "org" as const },
    ];
    render(() => (
      <RepoSelector
        selectedOrgs={["myorg"]}
        orgEntries={preloaded}
        selected={[]}
        onChange={vi.fn()}
      />
    ));
    await waitFor(() => {
      screen.getByText("repo-a");
    });
    expect(api.fetchOrgs).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import type { RepoRef, RepoEntry } from "../../../src/app/services/api";

// Mock getClient before importing component
const mockRequest = vi.fn().mockResolvedValue({ data: {} });
vi.mock("../../../src/app/services/github", () => ({
  getClient: () => ({ request: mockRequest }),
}));

vi.mock("../../../src/app/stores/auth", () => ({
  user: () => ({ login: "testuser", name: "Test User", avatar_url: "" }),
  token: () => "fake-token",
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
    discoverUpstreamRepos: vi.fn().mockResolvedValue([]),
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

  it("shows personal org first, then remaining orgs alphabetically", async () => {
    vi.mocked(api.fetchOrgs).mockResolvedValue([
      { login: "zebra-org", avatarUrl: "", type: "org" },
      { login: "testuser", avatarUrl: "", type: "user" },
      { login: "alpha-org", avatarUrl: "", type: "org" },
    ]);
    vi.mocked(api.fetchRepos).mockImplementation((_client, org) => {
      return Promise.resolve([
        { owner: org as string, name: "repo", fullName: `${org}/repo`, pushedAt: "2026-03-20T00:00:00Z" },
      ]);
    });
    render(() => (
      <RepoSelector selectedOrgs={["zebra-org", "testuser", "alpha-org"]} selected={[]} onChange={vi.fn()} />
    ));
    await waitFor(() => {
      expect(screen.getAllByText("repo").length).toBe(3);
    });
    const orgHeaders = screen.getAllByText(/^(testuser|alpha-org|zebra-org)$/);
    expect(orgHeaders[0].textContent).toBe("testuser");
    expect(orgHeaders[1].textContent).toBe("alpha-org");
    expect(orgHeaders[2].textContent).toBe("zebra-org");
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

  it("sorts orgs alphabetically regardless of repo activity", async () => {
    vi.mocked(api.fetchOrgs).mockResolvedValue([
      { login: "stale-org", avatarUrl: "", type: "org" },
      { login: "active-org", avatarUrl: "", type: "org" },
    ]);
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
    // Alphabetical: active-org before stale-org, regardless of pushedAt
    expect(orgHeaders[0].textContent).toBe("active-org");
    expect(orgHeaders[1].textContent).toBe("stale-org");
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

  it("per-org Select All is disabled when all repos already selected (non-accordion)", async () => {
    vi.mocked(api.fetchRepos).mockResolvedValue(myorgRepos);
    const allSelected: RepoRef[] = myorgRepos.map((r) => ({ owner: r.owner, name: r.name, fullName: r.fullName }));

    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={allSelected} onChange={vi.fn()} />
    ));

    await waitFor(() => {
      screen.getByText("repo-a");
    });

    // Non-accordion: per-org Select All is in the header
    const selectAllBtns = screen.getAllByText("Select All");
    const perOrgSelectAll = selectAllBtns[selectAllBtns.length - 1] as HTMLButtonElement;
    expect(perOrgSelectAll.disabled).toBe(true);
  });

  it("per-org Deselect All is disabled when no repos selected (non-accordion)", async () => {
    vi.mocked(api.fetchRepos).mockResolvedValue(myorgRepos);

    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={[]} onChange={vi.fn()} />
    ));

    await waitFor(() => {
      screen.getByText("repo-a");
    });

    // Non-accordion: per-org Deselect All is in the header
    const deselectAllBtns = screen.getAllByText("Deselect All");
    const perOrgDeselectAll = deselectAllBtns[deselectAllBtns.length - 1] as HTMLButtonElement;
    expect(perOrgDeselectAll.disabled).toBe(true);
  });
});

describe("RepoSelector — upstream discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.mocked(api.fetchRepos).mockResolvedValue(myorgRepos);
    vi.mocked(api.discoverUpstreamRepos).mockResolvedValue([]);
    mockRequest.mockReset().mockResolvedValue({ data: {} });
  });

  it("does not call discoverUpstreamRepos when showUpstreamDiscovery is false (default)", async () => {
    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={[]} onChange={vi.fn()} />
    ));
    await waitFor(() => {
      screen.getByText("repo-a");
    });
    // Verify discoverUpstreamRepos was never called after repos finished loading.
    // waitFor above already ensures the async effect settled (fetchRepos resolved),
    // so no additional delay is needed.
    expect(api.discoverUpstreamRepos).not.toHaveBeenCalled();
  });

  it("does not render Upstream Repositories heading when showUpstreamDiscovery is false", async () => {
    render(() => (
      <RepoSelector selectedOrgs={["myorg"]} selected={[]} onChange={vi.fn()} />
    ));
    await waitFor(() => screen.getByText("repo-a"));
    expect(screen.queryByText("Upstream Repositories")).toBeNull();
  });

  it("renders Upstream Repositories heading when showUpstreamDiscovery is true", async () => {
    render(() => (
      <RepoSelector
        selectedOrgs={["myorg"]}
        selected={[]}
        onChange={vi.fn()}
        showUpstreamDiscovery={true}
        upstreamRepos={[]}
        onUpstreamChange={vi.fn()}
      />
    ));
    await waitFor(() => {
      screen.getByText("Upstream Repositories");
    });
  });

  it("calls discoverUpstreamRepos after org repos load when showUpstreamDiscovery is true", async () => {
    render(() => (
      <RepoSelector
        selectedOrgs={["myorg"]}
        selected={[]}
        onChange={vi.fn()}
        showUpstreamDiscovery={true}
        upstreamRepos={[]}
        onUpstreamChange={vi.fn()}
      />
    ));
    await waitFor(() => {
      expect(api.discoverUpstreamRepos).toHaveBeenCalledOnce();
    });
    expect(api.discoverUpstreamRepos).toHaveBeenCalledWith(
      expect.anything(),
      "testuser",
      expect.any(Set),
      undefined
    );
  });

  it("shows discovered repos as checkboxes", async () => {
    const discovered: RepoRef[] = [
      { owner: "upstream-owner", name: "upstream-repo", fullName: "upstream-owner/upstream-repo" },
    ];
    vi.mocked(api.discoverUpstreamRepos).mockResolvedValue(discovered);

    render(() => (
      <RepoSelector
        selectedOrgs={["myorg"]}
        selected={[]}
        onChange={vi.fn()}
        showUpstreamDiscovery={true}
        upstreamRepos={[]}
        onUpstreamChange={vi.fn()}
      />
    ));

    await waitFor(() => {
      screen.getByText("upstream-owner/upstream-repo");
    });
  });

  it("selecting a discovered repo calls onUpstreamChange", async () => {
    const user = userEvent.setup();
    const discovered: RepoRef[] = [
      { owner: "upstream-owner", name: "upstream-repo", fullName: "upstream-owner/upstream-repo" },
    ];
    vi.mocked(api.discoverUpstreamRepos).mockResolvedValue(discovered);
    const onUpstreamChange = vi.fn();

    render(() => (
      <RepoSelector
        selectedOrgs={["myorg"]}
        selected={[]}
        onChange={vi.fn()}
        showUpstreamDiscovery={true}
        upstreamRepos={[]}
        onUpstreamChange={onUpstreamChange}
      />
    ));

    await waitFor(() => {
      screen.getByText("upstream-owner/upstream-repo");
    });

    const checkboxes = screen.getAllByRole("checkbox");
    const upstreamCheckbox = checkboxes.find((cb) => {
      const label = cb.closest("label");
      return label?.textContent?.includes("upstream-owner/upstream-repo");
    });
    await user.click(upstreamCheckbox!);

    expect(onUpstreamChange).toHaveBeenCalledWith([discovered[0]]);
  });

  it("discovered repos already in selectedRepos are excluded from the excludeSet passed to discoverUpstreamRepos", async () => {
    const selected: RepoRef[] = [
      { owner: "myorg", name: "repo-a", fullName: "myorg/repo-a" },
    ];

    render(() => (
      <RepoSelector
        selectedOrgs={["myorg"]}
        selected={selected}
        onChange={vi.fn()}
        showUpstreamDiscovery={true}
        upstreamRepos={[]}
        onUpstreamChange={vi.fn()}
      />
    ));

    await waitFor(() => {
      expect(api.discoverUpstreamRepos).toHaveBeenCalled();
    });

    const excludeSet = vi.mocked(api.discoverUpstreamRepos).mock.calls[0][2] as Set<string>;
    expect(excludeSet.has("myorg/repo-a")).toBe(true);
  });

  it("shows workflow runs note text", async () => {
    render(() => (
      <RepoSelector
        selectedOrgs={["myorg"]}
        selected={[]}
        onChange={vi.fn()}
        showUpstreamDiscovery={true}
        upstreamRepos={[]}
        onUpstreamChange={vi.fn()}
      />
    ));
    await waitFor(() => {
      screen.getByText(/workflow runs are not/i);
    });
  });

  it("manual entry: typing owner/repo and clicking Add calls onUpstreamChange", async () => {
    const user = userEvent.setup();
    const onUpstreamChange = vi.fn();

    render(() => (
      <RepoSelector
        selectedOrgs={["myorg"]}
        selected={[]}
        onChange={vi.fn()}
        showUpstreamDiscovery={true}
        upstreamRepos={[]}
        onUpstreamChange={onUpstreamChange}
      />
    ));

    await waitFor(() => {
      screen.getByText("Upstream Repositories");
    });

    const input = screen.getByRole("textbox", { name: /add upstream repo/i });
    await user.type(input, "some-owner/some-repo");
    await user.click(screen.getByRole("button", { name: /^Add$/ }));

    expect(onUpstreamChange).toHaveBeenCalledWith([
      { owner: "some-owner", name: "some-repo", fullName: "some-owner/some-repo" },
    ]);
  });

  it("manual entry: invalid format (no slash) shows validation error", async () => {
    const user = userEvent.setup();

    render(() => (
      <RepoSelector
        selectedOrgs={["myorg"]}
        selected={[]}
        onChange={vi.fn()}
        showUpstreamDiscovery={true}
        upstreamRepos={[]}
        onUpstreamChange={vi.fn()}
      />
    ));

    await waitFor(() => screen.getByText("Upstream Repositories"));

    const input = screen.getByRole("textbox", { name: /add upstream repo/i });
    await user.type(input, "noslash");
    await user.click(screen.getByRole("button", { name: /^Add$/ }));

    screen.getByText(/format must be owner\/repo/i);
  });

  it("manual entry: duplicate from selectedRepos shows duplicate error", async () => {
    const user = userEvent.setup();
    const selected: RepoRef[] = [
      { owner: "myorg", name: "repo-a", fullName: "myorg/repo-a" },
    ];

    render(() => (
      <RepoSelector
        selectedOrgs={["myorg"]}
        selected={selected}
        onChange={vi.fn()}
        showUpstreamDiscovery={true}
        upstreamRepos={[]}
        onUpstreamChange={vi.fn()}
      />
    ));

    await waitFor(() => screen.getByText("Upstream Repositories"));

    const input = screen.getByRole("textbox", { name: /add upstream repo/i });
    await user.type(input, "myorg/repo-a");
    await user.click(screen.getByRole("button", { name: /^Add$/ }));

    screen.getByText(/already in your selected/i);
  });

  it("manual entry: duplicate from upstream repos shows duplicate error", async () => {
    const user = userEvent.setup();

    render(() => (
      <RepoSelector
        selectedOrgs={["myorg"]}
        selected={[]}
        onChange={vi.fn()}
        showUpstreamDiscovery={true}
        upstreamRepos={[{ owner: "upstream-org", name: "upstream-repo", fullName: "upstream-org/upstream-repo" }]}
        onUpstreamChange={vi.fn()}
      />
    ));

    await waitFor(() => screen.getByText("Upstream Repositories"));

    const input = screen.getByRole("textbox", { name: /add upstream repo/i });
    await user.type(input, "upstream-org/upstream-repo");
    await user.click(screen.getByRole("button", { name: /^Add$/ }));

    screen.getByText(/already in upstream/i);
  });

  it("manual entry: duplicate from discovered repos shows discovered error", async () => {
    const user = userEvent.setup();
    const discovered: RepoRef[] = [
      { owner: "disc-org", name: "disc-repo", fullName: "disc-org/disc-repo" },
    ];
    vi.mocked(api.discoverUpstreamRepos).mockResolvedValue(discovered);

    render(() => (
      <RepoSelector
        selectedOrgs={["myorg"]}
        selected={[]}
        onChange={vi.fn()}
        showUpstreamDiscovery={true}
        upstreamRepos={[]}
        onUpstreamChange={vi.fn()}
      />
    ));

    await waitFor(() => {
      screen.getByText("disc-org/disc-repo");
    });

    const input = screen.getByRole("textbox", { name: /add upstream repo/i });
    await user.type(input, "disc-org/disc-repo");
    await user.click(screen.getByRole("button", { name: /^Add$/ }));

    screen.getByText(/already discovered/i);
  });

  it("manual entry: shows error when repo does not exist (404)", async () => {
    const user = userEvent.setup();
    mockRequest.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));

    render(() => (
      <RepoSelector
        selectedOrgs={["myorg"]}
        selected={[]}
        onChange={vi.fn()}
        showUpstreamDiscovery={true}
        upstreamRepos={[]}
        onUpstreamChange={vi.fn()}
      />
    ));

    await waitFor(() => screen.getByText("Upstream Repositories"));

    const input = screen.getByRole("textbox", { name: /add upstream repo/i });
    await user.type(input, "nonexistent-org/no-repo");
    await user.click(screen.getByRole("button", { name: /^Add$/ }));

    await waitFor(() => {
      screen.getByText(/repository not found/i);
    });
  });
});

// ── Monitor toggle (C4) ────────────────────────────────────────────────────────

describe("RepoSelector — monitor toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.fetchRepos).mockImplementation((_client, org) => {
      if (org === "myorg") return Promise.resolve(myorgRepos);
      return Promise.resolve([]);
    });
  });

  it("does not render monitor toggle when onMonitorToggle prop is absent", async () => {
    const selected: RepoRef[] = [{ owner: "myorg", name: "repo-a", fullName: "myorg/repo-a" }];
    render(() => (
      <RepoSelector
        selectedOrgs={["myorg"]}
        selected={selected}
        onChange={vi.fn()}
      />
    ));

    await waitFor(() => screen.getByText("repo-a"));
    expect(screen.queryByLabelText(/monitor all activity/i)).toBeNull();
  });

  it("renders monitor toggle only for selected repos", async () => {
    const selected: RepoRef[] = [{ owner: "myorg", name: "repo-a", fullName: "myorg/repo-a" }];
    // repo-b is not selected
    render(() => (
      <RepoSelector
        selectedOrgs={["myorg"]}
        selected={selected}
        onChange={vi.fn()}
        onMonitorToggle={vi.fn()}
      />
    ));

    await waitFor(() => screen.getByText("repo-a"));
    // Toggle for selected repo-a should be present
    screen.getByLabelText("Monitor all activity");
    // Toggle for unselected repo-b should not be present
    expect(screen.queryAllByLabelText(/monitor all activity/i)).toHaveLength(1);
  });

  it("calls onMonitorToggle with repo and monitored=true when repo is not monitored", async () => {
    const onMonitorToggle = vi.fn();
    const selected: RepoRef[] = [{ owner: "myorg", name: "repo-a", fullName: "myorg/repo-a" }];
    render(() => (
      <RepoSelector
        selectedOrgs={["myorg"]}
        selected={selected}
        onChange={vi.fn()}
        onMonitorToggle={onMonitorToggle}
        monitoredRepos={[]}
      />
    ));

    await waitFor(() => screen.getByText("repo-a"));
    const btn = screen.getByLabelText("Monitor all activity");
    btn.click();
    expect(onMonitorToggle).toHaveBeenCalledWith(
      { owner: "myorg", name: "repo-a", fullName: "myorg/repo-a" },
      true
    );
  });

  it("calls onMonitorToggle with monitored=false when repo is already monitored", async () => {
    const onMonitorToggle = vi.fn();
    const selected: RepoRef[] = [{ owner: "myorg", name: "repo-a", fullName: "myorg/repo-a" }];
    const monitoredRepos: RepoRef[] = [{ owner: "myorg", name: "repo-a", fullName: "myorg/repo-a" }];
    render(() => (
      <RepoSelector
        selectedOrgs={["myorg"]}
        selected={selected}
        onChange={vi.fn()}
        onMonitorToggle={onMonitorToggle}
        monitoredRepos={monitoredRepos}
      />
    ));

    await waitFor(() => screen.getByText("repo-a"));
    const btn = screen.getByLabelText("Stop monitoring all activity");
    btn.click();
    expect(onMonitorToggle).toHaveBeenCalledWith(
      { owner: "myorg", name: "repo-a", fullName: "myorg/repo-a" },
      false
    );
  });

  it("hides monitor toggle for upstream repos even when selected", async () => {
    const selected: RepoRef[] = [{ owner: "myorg", name: "repo-a", fullName: "myorg/repo-a" }];
    const upstreamRepos: RepoRef[] = [{ owner: "myorg", name: "repo-a", fullName: "myorg/repo-a" }];
    render(() => (
      <RepoSelector
        selectedOrgs={["myorg"]}
        selected={selected}
        onChange={vi.fn()}
        onMonitorToggle={vi.fn()}
        upstreamRepos={upstreamRepos}
      />
    ));

    await waitFor(() => screen.getByText("repo-a"));
    // Monitor toggle should not appear for upstream repos
    expect(screen.queryByLabelText(/monitor all activity/i)).toBeNull();
  });
});

// ── Org-grouped accordion (C2) ────────────────────────────────────────────────

describe("RepoSelector — org accordion", () => {
  // 6 org names that trigger accordion mode (threshold is >= 6)
  const sixOrgs = ["alpha-org", "beta-org", "gamma-org", "delta-org", "epsilon-org", "zeta-org"];

  // Minimal OrgEntry list for preloading (skips fetchOrgs network call)
  const sixOrgEntries = sixOrgs.map((login) => ({
    login,
    avatarUrl: "",
    type: "org" as const,
  }));

  // One repo per org
  function makeOrgRepos(org: string): RepoEntry[] {
    return [{ owner: org, name: `${org}-repo`, fullName: `${org}/${org}-repo`, pushedAt: "2026-03-20T10:00:00Z" }];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.mocked(api.fetchRepos).mockImplementation((_client, org) =>
      Promise.resolve(makeOrgRepos(org as string))
    );
  });

  it("renders all orgs expanded when fewer than 6 orgs", async () => {
    // 4 orgs → no accordion
    const fourOrgs = ["alpha-org", "beta-org", "gamma-org", "delta-org"];
    const fourOrgEntries = fourOrgs.map((login) => ({ login, avatarUrl: "", type: "org" as const }));

    render(() => (
      <RepoSelector
        selectedOrgs={fourOrgs}
        orgEntries={fourOrgEntries}
        selected={[]}
        onChange={vi.fn()}
      />
    ));

    await waitFor(() => {
      screen.getByText("alpha-org-repo");
      screen.getByText("delta-org-repo");
    });

    // No accordion header buttons present (no aria-expanded attributes)
    expect(document.querySelectorAll("[aria-expanded]")).toHaveLength(0);
    // All repo content visible (no inert panels)
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
  });

  it("renders all orgs expanded when exactly 5 orgs (boundary below threshold)", async () => {
    // 5 orgs → still no accordion (threshold is >= 6)
    const fiveOrgs = ["alpha-org", "beta-org", "gamma-org", "delta-org", "epsilon-org"];
    const fiveOrgEntries = fiveOrgs.map((login) => ({ login, avatarUrl: "", type: "org" as const }));

    render(() => (
      <RepoSelector
        selectedOrgs={fiveOrgs}
        orgEntries={fiveOrgEntries}
        selected={[]}
        onChange={vi.fn()}
      />
    ));

    await waitFor(() => {
      screen.getByText("alpha-org-repo");
      screen.getByText("epsilon-org-repo");
    });

    // No accordion chevron buttons present — 5 orgs is still below the >= 6 threshold
    expect(screen.queryAllByRole("button", { name: /chevron|expand|collapse/i })).toHaveLength(0);
    // All repo content visible — no inert panels
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
  });

  it("renders accordion with first org expanded by default when 6+ orgs", async () => {
    render(() => (
      <RepoSelector
        selectedOrgs={sixOrgs}
        orgEntries={sixOrgEntries}
        selected={[]}
        onChange={vi.fn()}
      />
    ));

    await waitFor(() => {
      screen.getByText("alpha-org-repo");
    });

    // First org panel is not inert (expanded)
    const panels = document.querySelectorAll("[inert]");
    // All other 5 orgs are collapsed (inert)
    expect(panels).toHaveLength(5);

    // First org repo content is accessible
    expect(screen.queryByText("alpha-org-repo")).not.toBeNull();
  });

  it("clicking another org header collapses the first and expands the clicked one", async () => {
    render(() => (
      <RepoSelector
        selectedOrgs={sixOrgs}
        orgEntries={sixOrgEntries}
        selected={[]}
        onChange={vi.fn()}
      />
    ));

    await waitFor(() => {
      screen.getByText("alpha-org-repo");
    });

    // Find and click the beta-org accordion header button
    const betaBtn = screen.getByRole("button", { name: /beta-org/ });
    fireEvent.click(betaBtn);

    // Now beta-org panel should be expanded (not inert), alpha-org collapsed
    await waitFor(() => {
      // 5 orgs still collapsed
      expect(document.querySelectorAll("[inert]")).toHaveLength(5);
    });

    // The expanded button should now be beta-org (aria-expanded=true)
    expect(betaBtn.getAttribute("aria-expanded")).toBe("true");
  });

  it("clicking the default-expanded org header is a no-op (null → explicit path)", async () => {
    render(() => (
      <RepoSelector
        selectedOrgs={sixOrgs}
        orgEntries={sixOrgEntries}
        selected={[]}
        onChange={vi.fn()}
      />
    ));

    await waitFor(() => {
      screen.getByText("alpha-org-repo");
    });

    // Click the already-expanded first org header
    const alphaBtn = screen.getByRole("button", { name: /alpha-org/ });
    fireEvent.click(alphaBtn);

    // alpha-org is still expanded (setUserExpandedOrg sets to same value)
    expect(alphaBtn.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelectorAll("[inert]")).toHaveLength(5);
  });

  it("clicking the explicitly-expanded org header a second time is a no-op (re-click path)", async () => {
    render(() => (
      <RepoSelector
        selectedOrgs={sixOrgs}
        orgEntries={sixOrgEntries}
        selected={[]}
        onChange={vi.fn()}
      />
    ));

    await waitFor(() => {
      screen.getByText("alpha-org-repo");
    });

    // First: click beta-org to explicitly set userExpandedOrg = 'beta-org'
    const betaBtn = screen.getByRole("button", { name: /beta-org/ });
    fireEvent.click(betaBtn);
    expect(betaBtn.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelectorAll("[inert]")).toHaveLength(5);

    // Second: click beta-org again — userExpandedOrg is already 'beta-org',
    // so setUserExpandedOrg('beta-org') is a no-op and beta-org must remain expanded
    fireEvent.click(betaBtn);
    expect(betaBtn.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelectorAll("[inert]")).toHaveLength(5);
  });

  it("shows repo count badge on org headers in accordion mode", async () => {
    render(() => (
      <RepoSelector
        selectedOrgs={sixOrgs}
        orgEntries={sixOrgEntries}
        selected={[]}
        onChange={vi.fn()}
      />
    ));

    await waitFor(() => {
      screen.getByText("alpha-org-repo");
    });

    // Each org has 1 repo — badge shows "1 repo"
    const badges = screen.getAllByText("1 repo");
    expect(badges.length).toBe(sixOrgs.length);
  });

  it("shows per-org Select All / Deselect All in expanded accordion panel", async () => {
    const onChange = vi.fn();
    render(() => (
      <RepoSelector
        selectedOrgs={sixOrgs}
        orgEntries={sixOrgEntries}
        selected={[]}
        onChange={onChange}
      />
    ));

    await waitFor(() => {
      screen.getByText("alpha-org-repo");
    });

    // The expanded org (alpha-org) should show per-org Select All in the header bar
    const headerBtn = document.getElementById("accordion-header-alpha-org")!;
    expect(headerBtn).not.toBeNull();
    const headerRow = headerBtn.parentElement!;
    const perOrgBtn = Array.from(headerRow.querySelectorAll("button")).find(
      (b) => b.textContent === "Select All" && b !== headerBtn
    );
    expect(perOrgBtn).not.toBeUndefined();
    fireEvent.click(perOrgBtn!);

    // Should select only alpha-org's repo
    expect(onChange).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ fullName: "alpha-org/alpha-org-repo" })])
    );
    // Should NOT include repos from other orgs
    const selectedNames = onChange.mock.calls[0][0].map((r: { fullName: string }) => r.fullName);
    expect(selectedNames).toHaveLength(1);
    expect(selectedNames[0]).toBe("alpha-org/alpha-org-repo");
  });

  it("per-org Select All is disabled when all repos already selected; Deselect All is disabled when none selected", async () => {
    const allSelected: RepoRef[] = sixOrgs.map((org) => ({
      owner: org,
      name: `${org}-repo`,
      fullName: `${org}/${org}-repo`,
    }));

    render(() => (
      <RepoSelector
        selectedOrgs={sixOrgs}
        orgEntries={sixOrgEntries}
        selected={allSelected}
        onChange={vi.fn()}
      />
    ));

    await waitFor(() => {
      screen.getByText("alpha-org-repo");
    });

    // alpha-org is expanded — per-org buttons are in the header bar
    const headerBtn = document.getElementById("accordion-header-alpha-org")!;
    const headerRow = headerBtn.parentElement!;
    const actionBtns = Array.from(headerRow.querySelectorAll("button")).filter((b) => b !== headerBtn);
    const perOrgSelectAll = actionBtns.find((b) => b.textContent === "Select All") as HTMLButtonElement;
    const perOrgDeselectAll = actionBtns.find((b) => b.textContent === "Deselect All") as HTMLButtonElement;

    // All repos are already selected — Select All must be disabled
    expect(perOrgSelectAll).not.toBeUndefined();
    expect(perOrgSelectAll.disabled).toBe(true);

    // All repos are selected — Deselect All must be enabled
    expect(perOrgDeselectAll).not.toBeUndefined();
    expect(perOrgDeselectAll.disabled).toBe(false);
  });

  it("per-org Deselect All is disabled when no repos are selected in that org", async () => {
    render(() => (
      <RepoSelector
        selectedOrgs={sixOrgs}
        orgEntries={sixOrgEntries}
        selected={[]}
        onChange={vi.fn()}
      />
    ));

    await waitFor(() => {
      screen.getByText("alpha-org-repo");
    });

    const headerBtn = document.getElementById("accordion-header-alpha-org")!;
    const headerRow = headerBtn.parentElement!;
    const actionBtns = Array.from(headerRow.querySelectorAll("button")).filter((b) => b !== headerBtn);
    const perOrgSelectAll = actionBtns.find((b) => b.textContent === "Select All") as HTMLButtonElement;
    const perOrgDeselectAll = actionBtns.find((b) => b.textContent === "Deselect All") as HTMLButtonElement;

    // No repos selected — Select All must be enabled
    expect(perOrgSelectAll).not.toBeUndefined();
    expect(perOrgSelectAll.disabled).toBe(false);

    // No repos selected — Deselect All must be disabled
    expect(perOrgDeselectAll).not.toBeUndefined();
    expect(perOrgDeselectAll.disabled).toBe(true);
  });

  it("per-org Deselect All in accordion panel deselects repos from that org", async () => {
    const preSelected: RepoRef[] = ["alpha-org", "beta-org"].map((org) => ({
      owner: org,
      name: `${org}-repo`,
      fullName: `${org}/${org}-repo`,
    }));
    const onChange = vi.fn();

    render(() => (
      <RepoSelector
        selectedOrgs={sixOrgs}
        orgEntries={sixOrgEntries}
        selected={preSelected}
        onChange={onChange}
      />
    ));

    await waitFor(() => {
      screen.getByText("alpha-org-repo");
    });

    // Deselect All is in the header bar when expanded
    const headerBtn = document.getElementById("accordion-header-alpha-org")!;
    const headerRow = headerBtn.parentElement!;
    const perOrgDeselectAll = Array.from(headerRow.querySelectorAll("button")).find(
      (b) => b.textContent === "Deselect All"
    ) as HTMLButtonElement;
    expect(perOrgDeselectAll).not.toBeUndefined();
    expect(perOrgDeselectAll.disabled).toBe(false);

    fireEvent.click(perOrgDeselectAll);

    // onChange should have been called with alpha-org's repo removed
    expect(onChange).toHaveBeenCalledOnce();
    const result = onChange.mock.calls[0][0] as RepoRef[];
    expect(result.map((r) => r.fullName)).not.toContain("alpha-org/alpha-org-repo");
    // beta-org's repo must still be selected
    expect(result.map((r) => r.fullName)).toContain("beta-org/beta-org-repo");
  });

  it("global Select All includes repos from collapsed orgs", async () => {
    const onChange = vi.fn();

    render(() => (
      <RepoSelector
        selectedOrgs={sixOrgs}
        orgEntries={sixOrgEntries}
        selected={[]}
        onChange={onChange}
      />
    ));

    await waitFor(() => {
      screen.getByText("alpha-org-repo");
    });

    // Click the global Select All (first button with that text)
    const selectAllBtns = screen.getAllByText("Select All");
    fireEvent.click(selectAllBtns[0]);

    expect(onChange).toHaveBeenCalled();
    const result = onChange.mock.calls[0][0] as RepoRef[];
    // Should include all 6 repos, one per org
    expect(result.length).toBe(6);
    for (const org of sixOrgs) {
      expect(result.map((r) => r.fullName)).toContain(`${org}/${org}-repo`);
    }
  });

  it("global Select All with text filter only includes repos matching the filter (PA-003)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(() => (
      <RepoSelector
        selectedOrgs={sixOrgs}
        orgEntries={sixOrgEntries}
        selected={[]}
        onChange={onChange}
      />
    ));

    await waitFor(() => {
      screen.getByText("alpha-org-repo");
    });

    // Type a filter that only matches repos in "alpha-org"
    const filterInput = screen.getByPlaceholderText(/Filter repos/i);
    await user.type(filterInput, "alpha-org-repo");

    // Wait for the debounce to fire and the filter to take effect:
    // the badge for "beta-org" should drop to "0 repos" once the filter is active
    await waitFor(() => {
      const betaBtn = screen.getByRole("button", { name: /beta-org/ });
      expect(betaBtn.textContent).toContain("0 repos");
    });

    // Click global Select All — should only include repos visible after filter
    const selectAllBtns = screen.getAllByText("Select All");
    fireEvent.click(selectAllBtns[0]);

    expect(onChange).toHaveBeenCalled();
    const result = onChange.mock.calls[0][0] as RepoRef[];
    // Only alpha-org-repo matches the filter
    expect(result.map((r) => r.fullName)).toContain("alpha-org/alpha-org-repo");
    // Repos from other orgs must NOT be included
    for (const org of sixOrgs.filter((o) => o !== "alpha-org")) {
      expect(result.map((r) => r.fullName)).not.toContain(`${org}/${org}-repo`);
    }
  });

  it("expanded org panel does not have inert; collapsed org panels do have inert", async () => {
    render(() => (
      <RepoSelector
        selectedOrgs={sixOrgs}
        orgEntries={sixOrgEntries}
        selected={[]}
        onChange={vi.fn()}
      />
    ));

    await waitFor(() => {
      screen.getByText("alpha-org-repo");
    });

    // In accordion mode, expanded org is alpha-org (first alphabetically)
    // The panel id is on the inner div that also carries the inert attribute
    const alphaPanel = document.getElementById("accordion-panel-alpha-org") as HTMLElement;
    expect(alphaPanel).not.toBeNull();
    expect(alphaPanel.hasAttribute("inert")).toBe(false);

    // All other org panels should have inert
    for (const org of sixOrgs.filter((o) => o !== "alpha-org")) {
      const panel = document.getElementById(`accordion-panel-${org}`) as HTMLElement;
      expect(panel).not.toBeNull();
      expect(panel.hasAttribute("inert")).toBe(true);
    }
  });

  it("org removal falls back to first remaining org when removed org was expanded", async () => {
    const { createSignal } = await import("solid-js");
    const [selectedOrgs, setSelectedOrgs] = createSignal<string[]>(sixOrgs);
    const [orgEntries, setOrgEntries] = createSignal(sixOrgEntries);

    render(() => (
      <RepoSelector
        selectedOrgs={selectedOrgs()}
        orgEntries={orgEntries()}
        selected={[]}
        onChange={vi.fn()}
      />
    ));

    await waitFor(() => {
      screen.getByText("alpha-org-repo");
    });

    // Expand the 3rd org (gamma-org)
    const gammaBtn = screen.getByRole("button", { name: /gamma-org/ });
    fireEvent.click(gammaBtn);
    expect(gammaBtn.getAttribute("aria-expanded")).toBe("true");

    // Start with 7 orgs so removing one leaves 6 (still in accordion mode)
    const sevenOrgs = [...sixOrgs, "eta-org"];
    const sevenOrgEntries = sevenOrgs.map((login) => ({ login, avatarUrl: "", type: "org" as const }));
    vi.mocked(api.fetchRepos).mockImplementation((_client, org) =>
      Promise.resolve(makeOrgRepos(org as string))
    );

    // Re-render to 7 orgs first
    setSelectedOrgs(sevenOrgs);
    setOrgEntries(sevenOrgEntries);

    await waitFor(() => {
      screen.getByText("eta-org-repo");
    });

    // Expand gamma-org
    const gammaBtnAgain = screen.getByRole("button", { name: /gamma-org/ });
    fireEvent.click(gammaBtnAgain);
    expect(gammaBtnAgain.getAttribute("aria-expanded")).toBe("true");

    // Now remove gamma-org (still 6 orgs remain → still accordion)
    const remainingOrgs = sevenOrgs.filter((o) => o !== "gamma-org");
    const remainingEntries = remainingOrgs.map((login) => ({ login, avatarUrl: "", type: "org" as const }));
    setSelectedOrgs(remainingOrgs);
    setOrgEntries(remainingEntries);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /gamma-org/ })).toBeNull();
    });

    // expandedOrg should fall back to states[0] (alpha-org)
    const alphaBtn = screen.getByRole("button", { name: /alpha-org/ });
    expect(alphaBtn.getAttribute("aria-expanded")).toBe("true");
  });
});

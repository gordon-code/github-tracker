import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import type { OrgEntry } from "../../../src/app/services/api";

// Mock getClient before importing component
vi.mock("../../../src/app/services/github", () => ({
  getClient: () => ({}),
}));

// Mock fetchOrgs from api module
vi.mock("../../../src/app/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/app/services/api")>();
  return {
    ...actual,
    fetchOrgs: vi.fn(),
  };
});

import * as api from "../../../src/app/services/api";
import OrgSelector from "../../../src/app/components/onboarding/OrgSelector";

const mockOrgs: OrgEntry[] = [
  { login: "myorg", avatarUrl: "https://example.com/myorg.png", type: "org" },
  { login: "anotheorg", avatarUrl: "https://example.com/anotheorg.png", type: "org" },
  { login: "personaluser", avatarUrl: "https://example.com/personaluser.png", type: "user" },
];

// Vitest skips its unhandledRejection handler when there are multiple listeners
// (see Vitest init source: `if (processListeners(event).length > 1) return`).
// Add a persistent no-op listener for this suite so that the rejected promise
// from the "shows error when fetch fails" test (which fires asynchronously into
// the next test) is not reported as an unhandled error.
// Cast to unknown first to avoid TypeScript's missing @types/node error.
const proc = (globalThis as Record<string, unknown>)["process"] as {
  on: (event: string, fn: (...args: unknown[]) => void) => void;
  off: (event: string, fn: (...args: unknown[]) => void) => void;
};
const suppressRejection = () => {};

describe("OrgSelector", () => {
  beforeAll(() => {
    proc.on("unhandledRejection", suppressRejection);
  });
  afterAll(() => {
    proc.off("unhandledRejection", suppressRejection);
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state while fetching", async () => {
    vi.mocked(api.fetchOrgs).mockReturnValue(new Promise(() => {}));
    render(() => <OrgSelector selected={[]} onChange={vi.fn()} />);
    screen.getByText(/Loading organizations/i);
  });

  it("renders org list after load", async () => {
    vi.mocked(api.fetchOrgs).mockResolvedValue(mockOrgs);
    render(() => <OrgSelector selected={[]} onChange={vi.fn()} />);

    await waitFor(() => {
      screen.getByText("myorg");
      screen.getByText("anotheorg");
      screen.getByText("personaluser");
    });
  });

  it("shows error when fetch fails", async () => {
    vi.mocked(api.fetchOrgs).mockRejectedValue(new Error("Network error"));
    render(() => <OrgSelector selected={[]} onChange={vi.fn()} />);

    await waitFor(() => {
      screen.getByText(/Failed to load organizations/i);
    });
  });

  it("initially selected orgs are checked", async () => {
    vi.mocked(api.fetchOrgs).mockResolvedValue(mockOrgs);
    render(() => <OrgSelector selected={["myorg"]} onChange={vi.fn()} />);

    await waitFor(() => {
      screen.getByText("myorg");
    });

    const checkboxes = screen.getAllByRole("checkbox");
    // Find the checkbox for "myorg" — it should be checked
    const myorgCheckbox = checkboxes.find((cb) => {
      const label = cb.closest("label");
      return label?.textContent?.includes("myorg");
    });
    expect(myorgCheckbox).toBeDefined();
    expect((myorgCheckbox as HTMLInputElement).checked).toBe(true);
  });

  it("onChange called when checkbox toggled", async () => {
    vi.mocked(api.fetchOrgs).mockResolvedValue(mockOrgs);
    const onChange = vi.fn();
    render(() => <OrgSelector selected={[]} onChange={onChange} />);

    await waitFor(() => {
      screen.getByText("myorg");
    });

    const checkboxes = screen.getAllByRole("checkbox");
    const myorgCheckbox = checkboxes.find((cb) => {
      const label = cb.closest("label");
      return label?.textContent?.includes("myorg");
    });

    fireEvent.click(myorgCheckbox!);
    expect(onChange).toHaveBeenCalledWith(["myorg"]);
  });

  it("filters by text input", async () => {
    vi.mocked(api.fetchOrgs).mockResolvedValue(mockOrgs);
    render(() => <OrgSelector selected={[]} onChange={vi.fn()} />);

    await waitFor(() => {
      screen.getByText("myorg");
    });

    const filterInput = screen.getByPlaceholderText(/Filter orgs/i);
    fireEvent.input(filterInput, { target: { value: "myorg" } });

    await waitFor(() => {
      expect(screen.queryByText("anotheorg")).toBeNull();
      screen.getByText("myorg");
    });
  });

  it("Select All selects all visible orgs", async () => {
    vi.mocked(api.fetchOrgs).mockResolvedValue(mockOrgs);
    const onChange = vi.fn();
    render(() => <OrgSelector selected={[]} onChange={onChange} />);

    await waitFor(() => {
      screen.getByText("myorg");
    });

    fireEvent.click(screen.getByText("Select All"));
    expect(onChange).toHaveBeenCalled();
    const called = onChange.mock.calls[0][0] as string[];
    expect(called).toContain("myorg");
    expect(called).toContain("anotheorg");
    expect(called).toContain("personaluser");
  });

  it("Deselect All deselects visible orgs", async () => {
    vi.mocked(api.fetchOrgs).mockResolvedValue(mockOrgs);
    const onChange = vi.fn();
    render(() => <OrgSelector selected={["myorg", "anotheorg"]} onChange={onChange} />);

    await waitFor(() => {
      screen.getByText("myorg");
    });

    fireEvent.click(screen.getByText("Deselect All"));
    expect(onChange).toHaveBeenCalled();
    const result = onChange.mock.calls[0][0] as string[];
    expect(result).not.toContain("myorg");
    expect(result).not.toContain("anotheorg");
  });

  it("shows Personal label for user type org", async () => {
    vi.mocked(api.fetchOrgs).mockResolvedValue(mockOrgs);
    render(() => <OrgSelector selected={[]} onChange={vi.fn()} />);

    await waitFor(() => {
      screen.getByText("Personal");
    });
  });

  it("shows count of selected orgs", async () => {
    vi.mocked(api.fetchOrgs).mockResolvedValue(mockOrgs);
    render(() => <OrgSelector selected={["myorg"]} onChange={vi.fn()} />);

    await waitFor(() => {
      screen.getByText(/1 of 3 selected/i);
    });
  });
});

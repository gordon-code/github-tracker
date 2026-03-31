import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";

// ── localStorage mock ─────────────────────────────────────────────────────────

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

vi.mock("../../../src/app/stores/auth", () => ({
  user: () => ({ login: "currentuser", name: "Current User", avatar_url: "" }),
  token: () => "fake-token",
  clearAuth: vi.fn(),
}));

vi.mock("../../../src/app/services/github", () => ({
  getClient: vi.fn(() => ({})),
}));

vi.mock("../../../src/app/services/api", () => ({
  validateGitHubUser: vi.fn(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import TrackedUsersSection from "../../../src/app/components/settings/TrackedUsersSection";
import * as apiModule from "../../../src/app/services/api";
import * as githubModule from "../../../src/app/services/github";
import type { TrackedUser } from "../../../src/app/stores/config";

// ── Test fixtures ─────────────────────────────────────────────────────────────

function makeUser(overrides: Partial<TrackedUser> = {}): TrackedUser {
  return {
    login: "octocat",
    avatarUrl: "https://avatars.githubusercontent.com/u/583231",
    name: "The Octocat",
    type: "user",
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.clear();
  vi.mocked(githubModule.getClient).mockReturnValue({} as ReturnType<typeof githubModule.getClient>);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TrackedUsersSection — rendering", () => {
  it("renders the add input and button", () => {
    render(() => (
      <TrackedUsersSection users={[]} onSave={vi.fn()} />
    ));
    screen.getByRole("textbox", { name: /github username/i });
    screen.getByRole("button", { name: /add/i });
  });

  it("renders existing tracked users with avatars and names", () => {
    const users = [
      makeUser({ login: "octocat", name: "The Octocat" }),
      makeUser({ login: "torvalds", name: "Linus Torvalds", avatarUrl: "https://avatars.githubusercontent.com/u/1024025" }),
    ];
    render(() => <TrackedUsersSection users={users} onSave={vi.fn()} />);

    screen.getByText("The Octocat");
    screen.getByText("octocat");
    screen.getByText("Linus Torvalds");
    screen.getByText("torvalds");

    const avatars = screen.getAllByRole("img");
    expect(avatars.length).toBeGreaterThanOrEqual(2);
  });

  it("shows login as display name when name is null", () => {
    const users = [makeUser({ login: "nameless", name: null })];
    render(() => <TrackedUsersSection users={users} onSave={vi.fn()} />);
    // Login should be rendered as the display name (only one occurrence, no muted login below)
    const elements = screen.getAllByText("nameless");
    expect(elements.length).toBe(1);
  });

  it("does not show API warning with fewer than 3 users", () => {
    const users = [makeUser(), makeUser({ login: "other" })];
    render(() => <TrackedUsersSection users={users} onSave={vi.fn()} />);
    expect(screen.queryByText(/rate limiting/i)).toBeNull();
  });

  it("shows API warning when 3 or more users are tracked", () => {
    const users = [
      makeUser({ login: "user1" }),
      makeUser({ login: "user2" }),
      makeUser({ login: "user3" }),
    ];
    render(() => <TrackedUsersSection users={users} onSave={vi.fn()} />);
    screen.getByText(/rate limiting/i);
  });

  it("shows API warning at exactly 3 users", () => {
    const users = [
      makeUser({ login: "a" }),
      makeUser({ login: "b" }),
      makeUser({ login: "c" }),
    ];
    render(() => <TrackedUsersSection users={users} onSave={vi.fn()} />);
    screen.getByText(/rate limiting/i);
  });
});

describe("TrackedUsersSection — adding a user", () => {
  it("calls onSave with updated array when adding a valid user", async () => {
    const onSave = vi.fn();
    const newUser = makeUser({ login: "newuser", name: "New User" });
    vi.mocked(apiModule.validateGitHubUser).mockResolvedValue(newUser);

    const user = userEvent.setup();
    render(() => <TrackedUsersSection users={[]} onSave={onSave} />);

    const input = screen.getByRole("textbox", { name: /github username/i });
    await user.type(input, "newuser");
    await user.click(screen.getByRole("button", { name: /add/i }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledOnce();
      expect(onSave).toHaveBeenCalledWith([newUser]);
    });
  });

  it("normalizes login to lowercase before calling validateGitHubUser", async () => {
    const onSave = vi.fn();
    const newUser = makeUser({ login: "mixedcase" });
    vi.mocked(apiModule.validateGitHubUser).mockResolvedValue(newUser);

    const user = userEvent.setup();
    render(() => <TrackedUsersSection users={[]} onSave={onSave} />);

    const input = screen.getByRole("textbox", { name: /github username/i });
    await user.type(input, "MixedCase");
    await user.click(screen.getByRole("button", { name: /add/i }));

    await waitFor(() => {
      expect(apiModule.validateGitHubUser).toHaveBeenCalledWith(expect.anything(), "mixedcase");
    });
  });

  it("clears input after successfully adding a user", async () => {
    const onSave = vi.fn();
    vi.mocked(apiModule.validateGitHubUser).mockResolvedValue(makeUser());

    const user = userEvent.setup();
    render(() => <TrackedUsersSection users={[]} onSave={onSave} />);

    const input = screen.getByRole("textbox", { name: /github username/i });
    await user.type(input, "octocat");
    await user.click(screen.getByRole("button", { name: /add/i }));

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe("");
    });
  });

  it("shows error when user is not found (validateGitHubUser returns null)", async () => {
    vi.mocked(apiModule.validateGitHubUser).mockResolvedValue(null);

    const user = userEvent.setup();
    render(() => <TrackedUsersSection users={[]} onSave={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: /github username/i }), "ghost");
    await user.click(screen.getByRole("button", { name: /add/i }));

    await waitFor(() => {
      screen.getByText("User not found");
    });
  });

  it("shows error when adding a duplicate user (case-insensitive)", async () => {
    const existing = makeUser({ login: "octocat" });
    const onSave = vi.fn();

    const user = userEvent.setup();
    render(() => <TrackedUsersSection users={[existing]} onSave={onSave} />);

    await user.type(screen.getByRole("textbox", { name: /github username/i }), "OCTOCAT");
    await user.click(screen.getByRole("button", { name: /add/i }));

    screen.getByText("Already tracking this user");
    expect(onSave).not.toHaveBeenCalled();
    expect(apiModule.validateGitHubUser).not.toHaveBeenCalled();
  });

  it("shows error when adding the current user's own login", async () => {
    const onSave = vi.fn();

    const user = userEvent.setup();
    render(() => <TrackedUsersSection users={[]} onSave={onSave} />);

    // auth mock returns login "currentuser"
    await user.type(screen.getByRole("textbox", { name: /github username/i }), "CurrentUser");
    await user.click(screen.getByRole("button", { name: /add/i }));

    screen.getByText("Your activity is already included in your dashboard");
    expect(onSave).not.toHaveBeenCalled();
    expect(apiModule.validateGitHubUser).not.toHaveBeenCalled();
  });

  it("disables input and button while validation is in-flight", async () => {
    let resolveValidation!: (v: TrackedUser | null) => void;
    vi.mocked(apiModule.validateGitHubUser).mockReturnValue(
      new Promise((resolve) => { resolveValidation = resolve; })
    );

    const user = userEvent.setup();
    render(() => <TrackedUsersSection users={[]} onSave={vi.fn()} />);

    const input = screen.getByRole("textbox", { name: /github username/i });
    const addBtn = screen.getByRole("button", { name: /add/i });

    await user.type(input, "slowuser");
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(input.hasAttribute("disabled")).toBe(true);
      expect(addBtn.hasAttribute("disabled")).toBe(true);
    });

    // Clean up
    resolveValidation(null);
  });

  it("shows error when validateGitHubUser throws (network error)", async () => {
    vi.mocked(apiModule.validateGitHubUser).mockRejectedValue(new Error("Network timeout"));

    const user = userEvent.setup();
    render(() => <TrackedUsersSection users={[]} onSave={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: /github username/i }), "someuser");
    await user.click(screen.getByRole("button", { name: /add/i }));

    await waitFor(() => {
      screen.getByText("Validation failed — try again");
    });
  });

  it("submits on Enter key press", async () => {
    const onSave = vi.fn();
    vi.mocked(apiModule.validateGitHubUser).mockResolvedValue(makeUser());

    const user = userEvent.setup();
    render(() => <TrackedUsersSection users={[]} onSave={onSave} />);

    const input = screen.getByRole("textbox", { name: /github username/i });
    await user.type(input, "octocat");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledOnce();
    });
  });
});

describe("TrackedUsersSection — removing a user", () => {
  it("calls onSave without the removed user when Remove is clicked", async () => {
    const users = [
      makeUser({ login: "user1", name: "User One" }),
      makeUser({ login: "user2", name: "User Two" }),
    ];
    const onSave = vi.fn();

    const user = userEvent.setup();
    render(() => <TrackedUsersSection users={users} onSave={onSave} />);

    const removeBtn = screen.getByRole("button", { name: /remove user1/i });
    await user.click(removeBtn);

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith([users[1]]);
  });

  it("renders remove button for each tracked user", () => {
    const users = [
      makeUser({ login: "user1" }),
      makeUser({ login: "user2" }),
      makeUser({ login: "user3" }),
    ];
    render(() => <TrackedUsersSection users={users} onSave={vi.fn()} />);

    screen.getByRole("button", { name: /remove user1/i });
    screen.getByRole("button", { name: /remove user2/i });
    screen.getByRole("button", { name: /remove user3/i });
  });
});

// ── Bot badge UI (C2) ─────────────────────────────────────────────────────────

describe("TrackedUsersSection — bot badge", () => {
  it("renders bot badge for type:bot user", () => {
    const users = [
      makeUser({ login: "dependabot[bot]", name: null, type: "bot" }),
    ];
    render(() => <TrackedUsersSection users={users} onSave={vi.fn()} />);
    screen.getByLabelText("dependabot[bot] is a bot account");
  });

  it("does not render bot badge for type:user", () => {
    const users = [makeUser({ login: "octocat", type: "user" })];
    render(() => <TrackedUsersSection users={users} onSave={vi.fn()} />);
    expect(screen.queryByText("bot")).toBeNull();
  });

  it("renders bot badge only for bot users in mixed list", () => {
    const users = [
      makeUser({ login: "octocat", type: "user" }),
      makeUser({ login: "dependabot[bot]", name: null, type: "bot", avatarUrl: "https://avatars.githubusercontent.com/u/27347476" }),
    ];
    render(() => <TrackedUsersSection users={users} onSave={vi.fn()} />);
    const badges = screen.getAllByLabelText("dependabot[bot] is a bot account");
    expect(badges).toHaveLength(1);
  });

  it("renders bot badge text 'bot'", () => {
    const users = [
      makeUser({ login: "khepri-bot[bot]", name: null, type: "bot" }),
    ];
    render(() => <TrackedUsersSection users={users} onSave={vi.fn()} />);
    const badge = screen.getByLabelText("khepri-bot[bot] is a bot account");
    expect(badge.textContent).toBe("bot");
  });
});

describe("TrackedUsersSection — bot input handling", () => {
  it("lowercases bot login with [bot] suffix before calling validateGitHubUser", async () => {
    const botUser = makeUser({ login: "khepri-bot[bot]", name: null, type: "bot" });
    vi.mocked(apiModule.validateGitHubUser).mockResolvedValue(botUser);

    const onSave = vi.fn();
    render(() => <TrackedUsersSection users={[]} onSave={onSave} />);

    const input = screen.getByRole("textbox", { name: /github username/i }) as HTMLInputElement;
    // Use fireEvent.input instead of userEvent.type — userEvent interprets [bot] as a special key sequence
    fireEvent.input(input, { target: { value: "Khepri-Bot[bot]" } });
    fireEvent.click(screen.getByRole("button", { name: /add/i }));

    await waitFor(() => {
      expect(apiModule.validateGitHubUser).toHaveBeenCalledWith(expect.anything(), "khepri-bot[bot]");
    });
  });
});

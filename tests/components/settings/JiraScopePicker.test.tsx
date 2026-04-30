import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import JiraScopePicker from "../../../src/app/components/settings/JiraScopePicker";
import type { IJiraClient } from "../../../src/app/services/jira-client";
import type { JiraFieldMeta } from "../../../src/shared/jira-types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeField(id: string, name: string, overrides: Partial<JiraFieldMeta> = {}): JiraFieldMeta {
  return { id, name, custom: true, ...overrides };
}

function makeSingleUserField(id: string, name: string): JiraFieldMeta {
  return makeField(id, name, { schema: { type: "user" } });
}

function makeMultiUserField(id: string, name: string): JiraFieldMeta {
  return makeField(id, name, { schema: { type: "array", items: "user" } });
}

function makeSystemField(id: string, name: string): JiraFieldMeta {
  return { id, name, custom: false, schema: { type: "string" } };
}

function makeNonUserCustomField(id: string, name: string): JiraFieldMeta {
  return makeField(id, name, { schema: { type: "string" } });
}

function makeClient(getFields: () => Promise<JiraFieldMeta[]>): IJiraClient {
  return {
    getIssue: vi.fn().mockResolvedValue(null),
    searchJql: vi.fn().mockResolvedValue({ issues: [], total: 0, maxResults: 100, startAt: 0 }),
    bulkFetch: vi.fn().mockResolvedValue({ issues: [] }),
    getFields,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("JiraScopePicker", () => {
  const onSave = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders only custom user-type fields (2 single-user + 1 multi-user shown, system + non-user excluded)", async () => {
    const client = makeClient(() => Promise.resolve([
      makeSingleUserField("customfield_1", "Account Manager"),
      makeSingleUserField("customfield_2", "Tech Lead"),
      makeMultiUserField("customfield_3", "Reviewers"),
      makeSystemField("assignee", "Assignee"),
      makeSystemField("reporter", "Reporter"),
      makeNonUserCustomField("customfield_4", "Sprint"),
    ]));

    render(() => (
      <JiraScopePicker
        client={client}
        selectedScopes={[]}
        onSave={onSave}
        onCancel={onCancel}
      />
    ));

    await waitFor(() => screen.getByText("Account Manager"));

    expect(screen.getByText("Account Manager")).toBeTruthy();
    expect(screen.getByText("Tech Lead")).toBeTruthy();
    expect(screen.getByText("Reviewers")).toBeTruthy();

    expect(screen.queryByText("Assignee")).toBeNull();
    expect(screen.queryByText("Reporter")).toBeNull();
    expect(screen.queryByText("Sprint")).toBeNull();
  });

  it("shows 'multi-user' badge for array-type user fields", async () => {
    const client = makeClient(() => Promise.resolve([
      makeSingleUserField("customfield_1", "Account Manager"),
      makeMultiUserField("customfield_2", "Reviewers"),
    ]));

    render(() => (
      <JiraScopePicker
        client={client}
        selectedScopes={[]}
        onSave={onSave}
        onCancel={onCancel}
      />
    ));

    await waitFor(() => screen.getByText("Reviewers"));

    expect(screen.getByText("multi-user")).toBeTruthy();
    const userBadges = screen.getAllByText("user");
    expect(userBadges.length).toBeGreaterThanOrEqual(1);
  });

  it("shows empty state when no user-type custom fields exist", async () => {
    const client = makeClient(() => Promise.resolve([
      makeSystemField("assignee", "Assignee"),
      makeNonUserCustomField("customfield_1", "Sprint"),
    ]));

    render(() => (
      <JiraScopePicker
        client={client}
        selectedScopes={[]}
        onSave={onSave}
        onCancel={onCancel}
      />
    ));

    await waitFor(() => screen.getByText(/No user-type custom fields found/i));
  });

  it("shows error state when getFields rejects", async () => {
    const client = makeClient(() => Promise.reject(new Error("Jira error")));

    render(() => (
      <JiraScopePicker
        client={client}
        selectedScopes={[]}
        onSave={onSave}
        onCancel={onCancel}
      />
    ));

    await waitFor(() => screen.getByText(/failed to load fields/i));
  });

  it("Save button calls onSave with selected scopes", async () => {
    const client = makeClient(() => Promise.resolve([
      makeSingleUserField("customfield_1", "Account Manager"),
    ]));

    const { container } = render(() => (
      <JiraScopePicker
        client={client}
        selectedScopes={[]}
        onSave={onSave}
        onCancel={onCancel}
      />
    ));

    await waitFor(() => screen.getByText("Account Manager"));

    const checkbox = container.querySelector("input[type=checkbox]") as HTMLInputElement;
    checkbox.click();

    screen.getByRole("button", { name: /save/i }).click();

    expect(onSave).toHaveBeenCalledOnce();
    const saved = vi.mocked(onSave).mock.calls[0][0] as Array<{ id: string }>;
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe("customfield_1");
  });

  it("Cancel button calls onCancel", async () => {
    const client = makeClient(() => Promise.resolve([]));

    render(() => (
      <JiraScopePicker
        client={client}
        selectedScopes={[]}
        onSave={onSave}
        onCancel={onCancel}
      />
    ));

    await waitFor(() => expect(screen.queryByText(/loading fields/i)).toBeNull());

    screen.getByRole("button", { name: /cancel/i }).click();

    expect(onCancel).toHaveBeenCalledOnce();
  });
});

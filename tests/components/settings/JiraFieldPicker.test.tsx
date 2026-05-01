import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import JiraFieldPicker from "../../../src/app/components/settings/JiraFieldPicker";
import type { IJiraClient } from "../../../src/app/services/jira-client";
import type { JiraFieldMeta } from "../../../src/shared/jira-types";
import type { JiraCustomField } from "../../../src/shared/schemas";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeCustomField(id: string, name: string): JiraFieldMeta {
  return { id, name, custom: true, schema: { type: "string" } };
}

function makeSystemField(id: string, name: string): JiraFieldMeta {
  return { id, name, custom: false };
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

describe("JiraFieldPicker", () => {
  const onSave = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders loading state while fetching fields", () => {
    const client = makeClient(() => new Promise(() => {})); // never resolves

    render(() => (
      <JiraFieldPicker
        client={client}
        selectedFields={[]}
        onSave={onSave}
        onCancel={onCancel}
      />
    ));

    expect(screen.getByText(/loading fields/i)).toBeTruthy();
  });

  it("renders only custom fields after fetch (5 custom + 3 system → only 5 shown)", async () => {
    const customFields = Array.from({ length: 5 }, (_, i) =>
      makeCustomField(`customfield_${i}`, `Custom Field ${i}`)
    );
    const systemFields = [
      makeSystemField("summary", "Summary"),
      makeSystemField("status", "Status"),
      makeSystemField("assignee", "Assignee"),
    ];

    const client = makeClient(() => Promise.resolve([...customFields, ...systemFields]));

    render(() => (
      <JiraFieldPicker
        client={client}
        selectedFields={[]}
        onSave={onSave}
        onCancel={onCancel}
      />
    ));

    await waitFor(() => screen.getByText("Custom Field 0"));

    for (let i = 0; i < 5; i++) {
      expect(screen.getByText(`Custom Field ${i}`)).toBeTruthy();
    }
    expect(screen.queryByText("Summary")).toBeNull();
    expect(screen.queryByText("Status")).toBeNull();
    expect(screen.queryByText("Assignee")).toBeNull();
  });

  it("search input filters visible fields", async () => {
    const client = makeClient(() => Promise.resolve([
      makeCustomField("customfield_1", "Story Points"),
      makeCustomField("customfield_2", "Sprint Name"),
      makeCustomField("customfield_3", "Epic Link"),
    ]));

    const { container } = render(() => (
      <JiraFieldPicker
        client={client}
        selectedFields={[]}
        onSave={onSave}
        onCancel={onCancel}
      />
    ));

    await waitFor(() => screen.getByText("Story Points"));

    const searchInput = container.querySelector("input[type=text]") as HTMLInputElement;
    searchInput.value = "sprint";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));

    await waitFor(() => {
      expect(screen.queryByText("Story Points")).toBeNull();
      expect(screen.getByText("Sprint Name")).toBeTruthy();
      expect(screen.queryByText("Epic Link")).toBeNull();
    });
  });

  it("cannot select more than 10 fields (11th checkbox is disabled)", async () => {
    const fields = Array.from({ length: 11 }, (_, i) =>
      makeCustomField(`customfield_${i}`, `Field ${i}`)
    );
    const selected: JiraCustomField[] = fields.slice(0, 10).map((f) => ({ id: f.id, name: f.name }));

    const client = makeClient(() => Promise.resolve(fields));

    render(() => (
      <JiraFieldPicker
        client={client}
        selectedFields={selected}
        onSave={onSave}
        onCancel={onCancel}
      />
    ));

    await waitFor(() => screen.getByText("Field 0"));

    const unselectedLabel = screen.getByText("Field 10").closest("label")!;
    const unselectedCheckbox = unselectedLabel.querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(unselectedCheckbox.disabled).toBe(true);
  });

  it("Save button calls onSave with selected fields", async () => {
    const client = makeClient(() => Promise.resolve([
      makeCustomField("customfield_1", "Story Points"),
    ]));

    const { container } = render(() => (
      <JiraFieldPicker
        client={client}
        selectedFields={[]}
        onSave={onSave}
        onCancel={onCancel}
      />
    ));

    await waitFor(() => screen.getByText("Story Points"));

    const checkbox = container.querySelector("input[type=checkbox]") as HTMLInputElement;
    checkbox.click();

    screen.getByRole("button", { name: /save/i }).click();

    expect(onSave).toHaveBeenCalledOnce();
    const savedFields = vi.mocked(onSave).mock.calls[0][0] as JiraCustomField[];
    expect(savedFields).toHaveLength(1);
    expect(savedFields[0].id).toBe("customfield_1");
  });

  it("Cancel button calls onCancel", async () => {
    const client = makeClient(() => Promise.resolve([]));

    render(() => (
      <JiraFieldPicker
        client={client}
        selectedFields={[]}
        onSave={onSave}
        onCancel={onCancel}
      />
    ));

    await waitFor(() => expect(screen.queryByText(/loading fields/i)).toBeNull());

    screen.getByRole("button", { name: /cancel/i }).click();

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows error state when getFields rejects", async () => {
    const client = makeClient(() => Promise.reject(new Error("Network error")));

    render(() => (
      <JiraFieldPicker
        client={client}
        selectedFields={[]}
        onSave={onSave}
        onCancel={onCancel}
      />
    ));

    await waitFor(() => screen.getByText(/failed to load fields/i));
  });
});

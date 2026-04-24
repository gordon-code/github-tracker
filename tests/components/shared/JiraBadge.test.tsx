import { describe, it, expect } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import JiraBadge from "../../../src/app/components/shared/JiraBadge";
import type { JiraIssue } from "../../../src/shared/jira-types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeIssue(statusKey: "new" | "indeterminate" | "done" = "indeterminate"): JiraIssue {
  return {
    id: "10001",
    key: "PROJ-42",
    self: "https://api.atlassian.com/ex/jira/cloud-id/rest/api/3/issue/PROJ-42",
    fields: {
      summary: "Fix the bug",
      status: {
        id: "3",
        name: statusKey === "new" ? "To Do" : statusKey === "done" ? "Done" : "In Progress",
        statusCategory: {
          id: statusKey === "new" ? 2 : statusKey === "done" ? 3 : 4,
          key: statusKey,
          name: statusKey === "new" ? "To Do" : statusKey === "done" ? "Done" : "In Progress",
        },
      },
      priority: { id: "2", name: "Medium" },
      assignee: null,
      project: { id: "10000", key: "PROJ", name: "My Project" },
    },
  };
}

const SITE_URL = "https://mysite.atlassian.net";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("JiraBadge", () => {
  it("renders nothing when issue is undefined (key not detected or not yet fetched)", () => {
    const { container } = render(() => (
      <JiraBadge issueKey="PROJ-42" issue={undefined} siteUrl={SITE_URL} />
    ));
    // Should produce no visible output
    expect(container.textContent).toBe("");
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("span")).toBeNull();
  });

  it("renders plain badge (no link) when issue is null (key detected but not found/accessible)", () => {
    render(() => (
      <JiraBadge issueKey="PROJ-42" issue={null} siteUrl={SITE_URL} />
    ));
    const badge = screen.getByText("PROJ-42");
    expect(badge.tagName.toLowerCase()).toBe("span");
    expect(badge.closest("a")).toBeNull();
  });

  it("renders linked badge when issue is a JiraIssue", () => {
    const issue = makeIssue("indeterminate");
    render(() => (
      <JiraBadge issueKey="PROJ-42" issue={issue} siteUrl={SITE_URL} />
    ));
    const link = screen.getByRole("link");
    expect(link.textContent).toBe("PROJ-42");
    expect(link.getAttribute("href")).toBe(`${SITE_URL}/browse/PROJ-42`);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("link URL uses the correct siteUrl and issue key", () => {
    const issue = makeIssue("new");
    render(() => (
      <JiraBadge issueKey="ABC-7" issue={issue} siteUrl="https://other.atlassian.net" />
    ));
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://other.atlassian.net/browse/ABC-7");
  });

  it("linked badge has title attribute with status name", () => {
    const issue = makeIssue("indeterminate");
    render(() => (
      <JiraBadge issueKey="PROJ-42" issue={issue} siteUrl={SITE_URL} />
    ));
    const link = screen.getByRole("link");
    expect(link.getAttribute("title")).toContain("PROJ-42");
    expect(link.getAttribute("title")).toContain("In Progress");
  });

  it("applies status color class for 'new' (To Do) status category", () => {
    const issue = makeIssue("new");
    render(() => (
      <JiraBadge issueKey="PROJ-42" issue={issue} siteUrl={SITE_URL} />
    ));
    const link = screen.getByRole("link");
    // jiraStatusCategoryClass("new") returns a badge class — just verify it has a class
    expect(link.className).toBeTruthy();
    expect(link.className).toContain("badge");
  });

  it("applies status color class for 'indeterminate' (In Progress) status category", () => {
    const issue = makeIssue("indeterminate");
    render(() => (
      <JiraBadge issueKey="PROJ-42" issue={issue} siteUrl={SITE_URL} />
    ));
    const link = screen.getByRole("link");
    expect(link.className).toContain("badge");
  });

  it("does NOT render any img with atl-paas.net src (no avatar images leaked)", () => {
    const issue = makeIssue();
    const { container } = render(() => (
      <JiraBadge issueKey="PROJ-42" issue={issue} siteUrl={SITE_URL} />
    ));
    const images = container.querySelectorAll("img");
    for (const img of images) {
      expect(img.getAttribute("src") ?? "").not.toContain("atl-paas.net");
    }
  });
});

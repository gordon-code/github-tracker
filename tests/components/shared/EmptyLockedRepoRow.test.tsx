import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import EmptyLockedRepoRow from "../../../src/app/components/shared/EmptyLockedRepoRow";

describe("EmptyLockedRepoRow", () => {
  it("renders the repo name", () => {
    const { getByText } = render(() => (
      <EmptyLockedRepoRow repoFullName="owner/repo" section="issues" />
    ));
    expect(getByText("owner/repo")).toBeTruthy();
  });

  it("sets data-repo-group attribute", () => {
    const { container } = render(() => (
      <EmptyLockedRepoRow repoFullName="owner/repo" section="issues" />
    ));
    const row = container.querySelector('[data-repo-group="owner/repo"]');
    expect(row).not.toBeNull();
  });

  it("applies de-emphasis styling", () => {
    const { container } = render(() => (
      <EmptyLockedRepoRow repoFullName="owner/repo" section="pulls" />
    ));
    const row = container.querySelector('[data-repo-group="owner/repo"]');
    expect(row?.className).toContain("opacity-40");
  });

  it("has no aria-expanded attribute (non-interactive)", () => {
    const { container } = render(() => (
      <EmptyLockedRepoRow repoFullName="owner/repo" section="actions" />
    ));
    expect(container.querySelector("[aria-expanded]")).toBeNull();
  });
});

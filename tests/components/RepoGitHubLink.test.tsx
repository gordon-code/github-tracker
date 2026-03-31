import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import RepoGitHubLink from "../../src/app/components/shared/RepoGitHubLink";

describe("RepoGitHubLink", () => {
  it("renders issues link with correct href and label", () => {
    const { container } = render(() => (
      <RepoGitHubLink repoFullName="owner/repo" section="issues" />
    ));
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://github.com/owner/repo/issues");
    expect(link.getAttribute("aria-label")).toBe("Open owner/repo issues on GitHub");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders pulls link with correct href and label", () => {
    const { container } = render(() => (
      <RepoGitHubLink repoFullName="owner/repo" section="pulls" />
    ));
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://github.com/owner/repo/pulls");
    expect(link.getAttribute("aria-label")).toBe("Open owner/repo pull requests on GitHub");
  });

  it("renders actions link with correct href and label", () => {
    const { container } = render(() => (
      <RepoGitHubLink repoFullName="owner/repo" section="actions" />
    ));
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://github.com/owner/repo/actions");
    expect(link.getAttribute("aria-label")).toBe("Open owner/repo actions on GitHub");
  });

  it("renders ExternalLinkIcon SVG with aria-hidden", () => {
    const { container } = render(() => (
      <RepoGitHubLink repoFullName="owner/repo" section="issues" />
    ));
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import type { GitHubStatusSummary } from "../../../src/app/services/github-status";

const mockGetGitHubStatus = vi.fn<() => GitHubStatusSummary | null>(() => null);

vi.mock("../../../src/app/services/github-status", () => ({
  getGitHubStatus: () => mockGetGitHubStatus(),
}));

import GitHubStatusBadge from "../../../src/app/components/shared/GitHubStatusBadge";

beforeEach(() => {
  vi.useFakeTimers();
  mockGetGitHubStatus.mockReset();
  mockGetGitHubStatus.mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GitHubStatusBadge", () => {
  it("renders neutral checking state before first fetch resolves", () => {
    mockGetGitHubStatus.mockReturnValue(null);
    const { container } = render(() => <GitHubStatusBadge />);
    const button = screen.getByRole("button", { name: "Checking GitHub status…" });
    expect(button).toBeTruthy();
    const dot = container.querySelector("span.rounded-full.w-2.h-2");
    expect(dot?.classList.contains("bg-base-content/20")).toBe(true);
  });

  it("severity 'none' shows success dot without pulse and popover shows operational message", () => {
    mockGetGitHubStatus.mockReturnValue({ severity: "none", incidents: [], fetchedAt: new Date() });
    const { container } = render(() => <GitHubStatusBadge />);
    const dot = container.querySelector("span.rounded-full.w-2.h-2")!;
    expect(dot.classList.contains("bg-success")).toBe(true);
    expect(container.querySelector(".animate-slow-pulse")).toBeNull();

    const button = screen.getByRole("button", { name: "All systems operational" });
    fireEvent.click(button);
    vi.advanceTimersByTime(0);
    expect(document.body.textContent).toContain("All systems operational");
    const link = screen.getByRole("link", { name: /View githubstatus\.com/i });
    expect(link.getAttribute("href")).toBe("https://www.githubstatus.com");
  });

  it("severity 'minor' shows warning dot without pulse class and popover shows incident details", () => {
    mockGetGitHubStatus.mockReturnValue({
      severity: "minor",
      incidents: [{ id: "1", name: "Degraded search", latestUpdateBody: "", affectedComponents: ["Search"] }],
      fetchedAt: new Date(),
    });
    const { container } = render(() => <GitHubStatusBadge />);
    const dot = container.querySelector("span.rounded-full.w-2.h-2")!;
    expect(dot.classList.contains("bg-warning")).toBe(true);
    expect(container.querySelector(".animate-slow-pulse")).toBeNull();

    const button = screen.getByRole("button", { name: "Minor GitHub service disruption" });
    fireEvent.click(button);
    vi.advanceTimersByTime(0);
    expect(screen.getByText("Degraded search")).toBeTruthy();
    expect(document.body.textContent).toContain("Affects: Search");
  });

  it("severity 'major' shows orange dot with pulse class", () => {
    mockGetGitHubStatus.mockReturnValue({
      severity: "major",
      incidents: [{ id: "1", name: "API outage", latestUpdateBody: "", affectedComponents: ["API Requests"] }],
      fetchedAt: new Date(),
    });
    const { container } = render(() => <GitHubStatusBadge />);
    const dot = container.querySelector("span.rounded-full.w-2.h-2")!;
    expect(dot.classList.contains("bg-orange-500")).toBe(true);
    expect(container.querySelector(".animate-slow-pulse")).not.toBeNull();
  });

  it("severity 'critical' with one incident shows critical color, pulse, and popover incident details", () => {
    mockGetGitHubStatus.mockReturnValue({
      severity: "critical",
      incidents: [
        {
          id: "1",
          name: "API outage",
          latestUpdateBody: "We are investigating the issue.",
          affectedComponents: ["API Requests", "Webhooks"],
        },
      ],
      fetchedAt: new Date(),
    });
    const { container } = render(() => <GitHubStatusBadge />);
    const dot = container.querySelector("span.rounded-full.w-2.h-2")!;
    expect(dot.classList.contains("bg-red-500")).toBe(true);
    expect(container.querySelector(".animate-slow-pulse")).not.toBeNull();

    const button = screen.getByRole("button", { name: "Critical GitHub service outage" });
    fireEvent.click(button);
    vi.advanceTimersByTime(0);
    expect(screen.getByText("API outage")).toBeTruthy();
    expect(document.body.textContent).toContain("Affects: API Requests, Webhooks");
    expect(document.body.textContent).toContain("We are investigating the issue.");
  });

  it("does not render incident name as HTML (XSS regression)", () => {
    const malicious = "<img src=x onerror=alert(1)>";
    mockGetGitHubStatus.mockReturnValue({
      severity: "critical",
      incidents: [{ id: "1", name: malicious, latestUpdateBody: "", affectedComponents: ["Actions"] }],
      fetchedAt: new Date(),
    });
    render(() => <GitHubStatusBadge />);
    const button = screen.getByRole("button", { name: "Critical GitHub service outage" });
    fireEvent.click(button);
    vi.advanceTimersByTime(0);
    expect(screen.getByText(malicious)).toBeTruthy();
    // document-scoped: Popover.Content teleports to document.body via Popover.Portal,
    // so a container-scoped query would trivially pass even if the vulnerability were real.
    expect(document.querySelector("img[onerror]")).toBeNull();
  });

  it("clicking the trigger while hovered suppresses the tooltip and shows the popover", () => {
    mockGetGitHubStatus.mockReturnValue({
      severity: "major",
      incidents: [{ id: "1", name: "Some outage", latestUpdateBody: "We are investigating", affectedComponents: ["Actions"] }],
      fetchedAt: new Date(),
    });
    const { container } = render(() => <GitHubStatusBadge />);
    const tooltipTrigger = container.querySelector("span.inline-flex")!;
    fireEvent.pointerEnter(tooltipTrigger);
    vi.advanceTimersByTime(300);
    // Kobalte keeps the tooltip's content node mounted (for exit transitions) even once
    // closed, marking it data-closed rather than removing it — so once opened, textContent
    // checks can't distinguish open/closed. Check the data-expanded state instead, matching
    // this file's existing convention for post-interaction assertions.
    let tooltipContent = document.querySelector('[role="tooltip"]');
    expect(tooltipContent?.hasAttribute("data-expanded")).toBe(true);

    const button = screen.getByRole("button", { name: "Major GitHub service outage" });
    fireEvent.click(button);
    vi.advanceTimersByTime(0);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    // Tooltip is suppressed (forceClosed) once the Popover opens...
    tooltipContent = document.querySelector('[role="tooltip"]');
    expect(tooltipContent?.hasAttribute("data-expanded")).toBe(false);
    // ...while the Popover's own content is present.
    expect(document.body.textContent).toContain("Some outage");
  });

  it("popover lists all incidents when multiple are present simultaneously", () => {
    mockGetGitHubStatus.mockReturnValue({
      severity: "major",
      incidents: [
        { id: "1", name: "API outage", latestUpdateBody: "", affectedComponents: ["API Requests"] },
        { id: "2", name: "Actions delays", latestUpdateBody: "", affectedComponents: ["Actions"] },
      ],
      fetchedAt: new Date(),
    });
    render(() => <GitHubStatusBadge />);
    const button = screen.getByRole("button", { name: "Major GitHub service outage" });
    fireEvent.click(button);
    vi.advanceTimersByTime(0);
    expect(screen.getByText("API outage")).toBeTruthy();
    expect(screen.getByText("Actions delays")).toBeTruthy();
    expect(document.body.textContent).toContain("Affects: API Requests");
    expect(document.body.textContent).toContain("Affects: Actions");
  });

  it("focusing the trigger shows the tooltip via keyboard access, and opening the popover suppresses it", () => {
    mockGetGitHubStatus.mockReturnValue({
      severity: "major",
      incidents: [{ id: "1", name: "Some outage", latestUpdateBody: "We are investigating", affectedComponents: ["Actions"] }],
      fetchedAt: new Date(),
    });
    const { container } = render(() => <GitHubStatusBadge />);
    const tooltipTrigger = container.querySelector("span.inline-flex")!;
    fireEvent.focusIn(tooltipTrigger);
    // focusIn opens the Tooltip immediately (no hover delay) — see Tooltip.tsx onFocusIn.
    let tooltipContent = document.querySelector('[role="tooltip"]');
    expect(tooltipContent?.hasAttribute("data-expanded")).toBe(true);

    const button = screen.getByRole("button", { name: "Major GitHub service outage" });
    fireEvent.click(button);
    vi.advanceTimersByTime(0);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    // Tooltip is suppressed (forceClosed) once the Popover opens, even though focus never left...
    tooltipContent = document.querySelector('[role="tooltip"]');
    expect(tooltipContent?.hasAttribute("data-expanded")).toBe(false);
    // ...while the Popover's own content is present.
    expect(document.body.textContent).toContain("Some outage");
  });
});

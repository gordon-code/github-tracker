import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import WhatsNewDialog from "../../../src/app/components/shared/WhatsNewDialog";
import { config, resetConfig } from "../../../src/app/stores/config";
import { _resetChangelogCacheForTest } from "../../../src/app/lib/changelog";
import {
  APP_VERSION,
  _resetVersionStateForTest,
  _setAppVersionForTest,
} from "../../../src/app/lib/version";
import type { ChangelogEntry } from "../../../src/shared/changelog-schema";

describe("WhatsNewDialog", () => {
  beforeEach(() => {
    resetConfig();
    _resetVersionStateForTest();
    _resetChangelogCacheForTest();
  });

  afterEach(() => {
    resetConfig();
    _resetVersionStateForTest();
    _resetChangelogCacheForTest();
  });

  it("renders entries with version, date, section headings, items, PR link, commit SHA link, and full changelog link", () => {
    const entries: ChangelogEntry[] = [
      {
        version: "0.2.0",
        date: "2026-11-10",
        sections: [
          {
            title: "Features",
            items: [
              {
                text: "dashboard: add keyboard navigation",
                pr: 190,
                sha: "1a2b3c4d5e6f",
              },
            ],
          },
        ],
      },
    ];

    render(() => (
      <WhatsNewDialog open={true} onOpenChange={() => {}} entries={entries} />
    ));

    expect(screen.getByText("What's New")).toBeDefined();
    expect(screen.getByText("v0.2.0")).toBeDefined();
    expect(screen.getByText("2026-11-10")).toBeDefined();
    expect(screen.getByText("Features")).toBeDefined();
    expect(screen.getByText("dashboard: add keyboard navigation")).toBeDefined();

    const prLink = screen.getByRole("link", { name: "#190" });
    expect(prLink.getAttribute("href")).toBe(
      "https://github.com/gordon-code/github-tracker/pull/190",
    );
    expect(prLink.getAttribute("target")).toBe("_blank");
    expect(prLink.getAttribute("rel")).toBe("noopener noreferrer");

    const shaLink = screen.getByRole("link", { name: "(1a2b3c4)" });
    expect(shaLink.getAttribute("href")).toBe(
      "https://github.com/gordon-code/github-tracker/commit/1a2b3c4d5e6f",
    );
    expect(shaLink.getAttribute("target")).toBe("_blank");
    expect(shaLink.getAttribute("rel")).toBe("noopener noreferrer");

    const fullLink = screen.getByRole("link", { name: "Full changelog on GitHub" });
    expect(fullLink.getAttribute("href")).toBe(
      "https://github.com/gordon-code/github-tracker/blob/main/CHANGELOG.md",
    );
  });

  it("renders <script>, <img onerror>, and javascript: strings literally as text nodes, truncates 300+ char strings, and ensures every href points to github.com/gordon-code/github-tracker/", () => {
    const overlong = "A".repeat(350);
    const entries: ChangelogEntry[] = [
      {
        version: "0.1.0",
        date: "2026-11-06",
        sections: [
          {
            title: "Security",
            items: [
              {
                text: "<script>window.__xss=1</script> <img src=x onerror=alert(1)> javascript:alert(1)",
                pr: 42,
                sha: "abcdef1",
              },
              {
                text: overlong,
                // Invalid sha and negative pr should produce no link
                pr: -5,
                sha: "javascript:alert(1)",
              },
            ],
          },
        ],
      },
    ];

    render(() => (
      <WhatsNewDialog open={true} onOpenChange={() => {}} entries={entries} />
    ));

    // XSS strings rendered literally as text nodes; no <script> or <img> elements created
    expect(
      screen.getByText(
        "<script>window.__xss=1</script> <img src=x onerror=alert(1)> javascript:alert(1)",
      ),
    ).toBeDefined();
    expect(document.body.querySelectorAll("script").length).toBe(0);
    expect(document.body.querySelectorAll("img").length).toBe(0);

    // 350-char string truncated to 300 chars
    expect(screen.getByText("A".repeat(300))).toBeDefined();
    expect(screen.queryByText(overlong)).toBeNull();

    // Every rendered [href] matches ^https://github\.com/gordon-code/github-tracker/
    const anchors = Array.from(document.body.querySelectorAll("a[href]"));
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      expect(a.getAttribute("href")).toMatch(
        /^https:\/\/github\.com\/gordon-code\/github-tracker\//,
      );
    }
  });

  it("sets config.lastSeenVersion to APP_VERSION when opened with strict x.y.z APP_VERSION, and skips writing when APP_VERSION is not strict x.y.z", () => {
    expect(config.lastSeenVersion).toBeNull();
    expect(APP_VERSION).toBe("0.1.0");

    const { unmount } = render(() => (
      <WhatsNewDialog open={true} onOpenChange={() => {}} entries={[]} />
    ));
    expect(config.lastSeenVersion).toBe("0.1.0");
    unmount();

    // Reset and test non-strict APP_VERSION
    resetConfig();
    _setAppVersionForTest("0.1.0-dev");
    render(() => (
      <WhatsNewDialog open={true} onOpenChange={() => {}} entries={[]} />
    ));
    expect(config.lastSeenVersion).toBeNull();
  });

  it("renders 'No release notes available.' empty state when entries is empty", () => {
    render(() => (
      <WhatsNewDialog open={true} onOpenChange={() => {}} entries={[]} />
    ));

    expect(screen.getByText("No release notes available.")).toBeDefined();
  });

  it("lazily loads changelog entries via loadChangelog() when entries prop is omitted", async () => {
    render(() => <WhatsNewDialog open={true} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("v0.1.0")).toBeDefined();
      expect(screen.getByText("v0.0.9")).toBeDefined();
      expect(
        screen.getByText(
          "version: add in-app What's New dialog generated from CHANGELOG",
        ),
      ).toBeDefined();
    });
  });

  it("contains zero occurrences of innerHTML in WhatsNewDialog.tsx source", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/app/components/shared/WhatsNewDialog.tsx"),
      "utf8",
    );
    expect(source).not.toContain("innerHTML");
  });
});

import { describe, it, expect } from "vitest";
import { TRACKED_COMPONENT_NAMES } from "../../src/app/services/github-status";

// Live network smoke test — NOT part of `pnpm test` (excluded in vitest.workspace.ts).
// Run explicitly via `pnpm test:status-smoke`. Converts silent Statuspage
// component-name drift (see TRACKED_COMPONENT_NAMES's doc comment) into a loud,
// actionable CI failure instead of an undetected missed-outage bug.
describe("github-status live API shape (smoke)", () => {
  it("all TRACKED_COMPONENT_NAMES are present in the live summary.json component list", async () => {
    const res = await fetch("https://www.githubstatus.com/api/v2/summary.json");
    expect(res.ok).toBe(true);

    const json = (await res.json()) as { components: Array<{ name: string }> };
    const liveNames = new Set(json.components.map((c) => c.name));

    for (const tracked of TRACKED_COMPONENT_NAMES) {
      expect(liveNames.has(tracked)).toBe(true);
    }
  });
});

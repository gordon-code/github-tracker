import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@solidjs/testing-library";
import { Show } from "solid-js";
import { updateGraphqlRateLimit, getGraphqlRateLimit } from "../../../src/app/services/github";

// Minimal component replicating the footer span CSS ternary from DashboardPage.
function RateLimitSpan() {
  return (
    <Show when={getGraphqlRateLimit()}>
      {(rl) => (
        <span
          data-testid="rl-span"
          class={`tabular-nums ${
            rl().remaining === 0
              ? "text-error"
              : rl().remaining < rl().limit * 0.1
              ? "text-warning"
              : ""
          }`}
        >
          API RL: {rl().remaining}/{rl().limit}
        </span>
      )}
    </Show>
  );
}

afterEach(() => {
  cleanup();
});

// ── Footer span CSS class — three-tier logic ──────────────────────────────────

describe("DashboardPage footer — rate limit span CSS classes", () => {
  it("remaining: 0 gives text-error class", () => {
    const resetAt = new Date(Date.now() + 3600 * 1000).toISOString();
    updateGraphqlRateLimit({ limit: 5000, remaining: 0, resetAt });

    render(() => <RateLimitSpan />);
    const span = screen.getByTestId("rl-span");
    expect(span.className).toContain("text-error");
    expect(span.className).not.toContain("text-warning");
  });

  it("remaining < 10% of limit gives text-warning class", () => {
    const resetAt = new Date(Date.now() + 3600 * 1000).toISOString();
    // 100 / 5000 = 2% → below 10% threshold
    updateGraphqlRateLimit({ limit: 5000, remaining: 100, resetAt });

    render(() => <RateLimitSpan />);
    const span = screen.getByTestId("rl-span");
    expect(span.className).toContain("text-warning");
    expect(span.className).not.toContain("text-error");
  });

  it("remaining >= 10% of limit gives neither CSS class", () => {
    const resetAt = new Date(Date.now() + 3600 * 1000).toISOString();
    // 3000 / 5000 = 60% → normal range
    updateGraphqlRateLimit({ limit: 5000, remaining: 3000, resetAt });

    render(() => <RateLimitSpan />);
    const span = screen.getByTestId("rl-span");
    expect(span.className).not.toContain("text-error");
    expect(span.className).not.toContain("text-warning");
  });

  it("remaining exactly at 10% threshold (= boundary) gives neither class", () => {
    const resetAt = new Date(Date.now() + 3600 * 1000).toISOString();
    // 500 / 5000 = exactly 10% — NOT strictly less than, so no warning
    updateGraphqlRateLimit({ limit: 5000, remaining: 500, resetAt });

    render(() => <RateLimitSpan />);
    const span = screen.getByTestId("rl-span");
    expect(span.className).not.toContain("text-error");
    expect(span.className).not.toContain("text-warning");
  });

  it("remaining just below 10% threshold gives text-warning", () => {
    const resetAt = new Date(Date.now() + 3600 * 1000).toISOString();
    // 499 / 5000 = 9.98% → strictly less than 10%
    updateGraphqlRateLimit({ limit: 5000, remaining: 499, resetAt });

    render(() => <RateLimitSpan />);
    const span = screen.getByTestId("rl-span");
    expect(span.className).toContain("text-warning");
  });
});

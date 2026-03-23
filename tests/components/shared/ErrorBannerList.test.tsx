import { describe, it, expect } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import ErrorBannerList, { type ErrorBannerItem } from "../../../src/app/components/shared/ErrorBannerList";

function makeErrorBanner(overrides: Partial<ErrorBannerItem> = {}): ErrorBannerItem {
  return {
    source: "owner/repo",
    message: "Internal server error",
    retryable: true,
    ...overrides,
  };
}

describe("ErrorBannerList", () => {
  it("renders nothing when errors is undefined", () => {
    const { container } = render(() => <ErrorBannerList />);
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("renders nothing when errors is empty array", () => {
    const { container } = render(() => <ErrorBannerList errors={[]} />);
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("renders one alert per error with source name and message", () => {
    const errors = [
      makeErrorBanner({ source: "owner/repo-a", message: "Not found", retryable: false }),
      makeErrorBanner({ source: "owner/repo-b", message: "Server error", retryable: false }),
    ];
    render(() => <ErrorBannerList errors={errors} />);
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(2);
    expect(alerts[0].textContent).toContain("owner/repo-a");
    expect(alerts[0].textContent).toContain("Not found");
    expect(alerts[1].textContent).toContain("owner/repo-b");
    expect(alerts[1].textContent).toContain("Server error");
  });

  it('shows "(will retry)" for retryable errors', () => {
    const errors = [makeErrorBanner({ retryable: true, message: "Timeout" })];
    render(() => <ErrorBannerList errors={errors} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("(will retry)");
  });

  it('does not show "(will retry)" for non-retryable errors', () => {
    const errors = [makeErrorBanner({ retryable: false, message: "Forbidden" })];
    render(() => <ErrorBannerList errors={errors} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).not.toContain("(will retry)");
  });
});

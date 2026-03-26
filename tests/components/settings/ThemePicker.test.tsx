import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";

// Mock config store
const mockSetConfig = vi.fn();
vi.mock("../../../src/app/stores/config", () => ({
  config: { theme: "light" },
  setConfig: (...args: unknown[]) => mockSetConfig(...args),
  THEME_OPTIONS: ["light", "dark", "nord", "dracula", "synthwave", "corporate", "cupcake", "forest", "coffee", "dim"] as const,
  DARK_THEMES: new Set(["dark", "dracula", "synthwave", "forest", "coffee", "dim"]),
}));

import ThemePicker from "../../../src/app/components/settings/ThemePicker";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ThemePicker", () => {
  it("renders a button for each theme option", () => {
    render(() => <ThemePicker />);
    // 10 themes defined in THEME_OPTIONS
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBe(10);
  });

  it("renders theme buttons with correct aria-labels", () => {
    render(() => <ThemePicker />);
    screen.getByRole("button", { name: "Theme: light" });
    screen.getByRole("button", { name: "Theme: dark" });
    screen.getByRole("button", { name: "Theme: nord" });
  });

  it("marks current theme as aria-pressed=true", () => {
    render(() => <ThemePicker />);
    const lightBtn = screen.getByRole("button", { name: "Theme: light" });
    expect(lightBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("marks non-current themes as aria-pressed=false", () => {
    render(() => <ThemePicker />);
    const darkBtn = screen.getByRole("button", { name: "Theme: dark" });
    expect(darkBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("calls setConfig with 'theme' and theme name on click", async () => {
    const user = userEvent.setup();
    render(() => <ThemePicker />);
    const darkBtn = screen.getByRole("button", { name: "Theme: dark" });
    await user.click(darkBtn);
    expect(mockSetConfig).toHaveBeenCalledWith("theme", "dark");
  });

  it("renders theme name as visible text in each button", () => {
    render(() => <ThemePicker />);
    screen.getByText("light");
    screen.getByText("dark");
    screen.getByText("nord");
  });

  it("sets data-theme attribute on each button", () => {
    const { container } = render(() => <ThemePicker />);
    const lightBtn = container.querySelector('[data-theme="light"]');
    expect(lightBtn).not.toBeNull();
  });
});

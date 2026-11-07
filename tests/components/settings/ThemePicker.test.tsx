import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";

// Mock config store
const mockSetConfig = vi.fn();
vi.mock("../../../src/app/stores/config", () => ({
  config: { theme: "auto" },
  setConfig: (...args: unknown[]) => mockSetConfig(...args),
  THEME_OPTIONS: ["auto", "corporate", "cupcake", "light", "nord", "dim", "dracula", "dark", "forest"] as const,
  DARK_THEMES: new Set(["dim", "dracula", "dark", "forest"]),
}));

import ThemePicker from "../../../src/app/components/settings/ThemePicker";
import { _resetVersionStateForTests, _setSchemaStaleForTests } from "../../../src/app/lib/version";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ThemePicker", () => {
  it("renders a button for each theme option", () => {
    render(() => <ThemePicker />);
    // 8 concrete themes + 1 auto banner = 9 buttons
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBe(9);
  });

  it("renders theme buttons with correct aria-labels", () => {
    render(() => <ThemePicker />);
    screen.getByRole("button", { name: "Theme: auto (follows system)" });
    screen.getByRole("button", { name: "Theme: light" });
    screen.getByRole("button", { name: "Theme: dark" });
    screen.getByRole("button", { name: "Theme: nord" });
  });

  it("marks current theme as aria-pressed=true", () => {
    render(() => <ThemePicker />);
    const autoBtn = screen.getByRole("button", { name: "Theme: auto (follows system)" });
    expect(autoBtn.getAttribute("aria-pressed")).toBe("true");
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

  it("renders the Auto option as a native button so disabling and keyboard activation work", () => {
    render(() => <ThemePicker />);
    const autoBtn = screen.getByRole("button", { name: "Theme: auto (follows system)" });
    expect(autoBtn.tagName).toBe("BUTTON");
    expect(autoBtn.getAttribute("type")).toBe("button");
  });

  it("calls setConfig with 'auto' when the Auto option is clicked", async () => {
    const user = userEvent.setup();
    render(() => <ThemePicker />);
    await user.click(screen.getByRole("button", { name: "Theme: auto (follows system)" }));
    expect(mockSetConfig).toHaveBeenCalledWith("theme", "auto");
  });

  describe("while the stored-data schema is stale", () => {
    afterEach(() => {
      _resetVersionStateForTests();
    });

    it("disables the Auto option and every theme swatch, and clicking changes nothing", async () => {
      const user = userEvent.setup();
      render(() => <ThemePicker />);
      _setSchemaStaleForTests(true);

      const buttons = screen.getAllByRole("button");
      expect(buttons).toHaveLength(9);
      for (const button of buttons) expect((button as HTMLButtonElement).disabled).toBe(true);

      await user.click(screen.getByRole("button", { name: "Theme: auto (follows system)" }));
      await user.click(screen.getByRole("button", { name: "Theme: dark" }));
      expect(mockSetConfig).not.toHaveBeenCalled();
    });

    it("re-enables the options once the schema matches again", () => {
      render(() => <ThemePicker />);
      _setSchemaStaleForTests(true);
      _setSchemaStaleForTests(false);
      for (const button of screen.getAllByRole("button")) {
        expect((button as HTMLButtonElement).disabled).toBe(false);
      }
    });
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

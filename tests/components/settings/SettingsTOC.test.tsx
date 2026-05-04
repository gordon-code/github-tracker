import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@solidjs/testing-library";
import SettingsTOC, { SETTINGS_SECTIONS } from "../../../src/app/components/settings/SettingsTOC";
import { SETTINGS_PAGE_SECTION_IDS } from "../../../src/app/components/settings/SettingsPage";

let observerCallback: IntersectionObserverCallback;
const mockObserve = vi.fn();
const mockDisconnect = vi.fn();

beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: IntersectionObserverCallback) {
        observerCallback = cb;
      }
      observe = mockObserve;
      disconnect = mockDisconnect;
      unobserve = vi.fn();
    }
  );

  for (const s of SETTINGS_SECTIONS) {
    const el = document.createElement("div");
    el.id = s.id;
    document.body.appendChild(el);
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const s of SETTINGS_SECTIONS) {
    document.getElementById(s.id)?.remove();
  }
});

describe("SettingsTOC — section registry", () => {
  it("has exactly 12 entries", () => {
    expect(SETTINGS_SECTIONS).toHaveLength(12);
  });

  it("has all 4 groups", () => {
    const groups = [...new Set(SETTINGS_SECTIONS.map((s) => s.group))];
    expect(groups).toEqual(["Data Sources", "Display", "Integrations", "Account"]);
  });

  it("has non-empty id, label, and group for every entry", () => {
    for (const s of SETTINGS_SECTIONS) {
      expect(s.id).toBeTruthy();
      expect(s.label).toBeTruthy();
      expect(s.group).toBeTruthy();
    }
  });
});

describe("SettingsTOC — registry-DOM sync", () => {
  it("SETTINGS_SECTIONS IDs match SETTINGS_PAGE_SECTION_IDS", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual(SETTINGS_PAGE_SECTION_IDS);
  });
});

describe("SettingsTOC — desktop rendering", () => {
  it("renders all groups and sections in the desktop nav", () => {
    render(() => <SettingsTOC />);
    const nav = screen.getByRole("navigation", { name: "Settings navigation" });

    within(nav).getByText("Data Sources");
    within(nav).getByText("Display");
    within(nav).getByText("Integrations");
    within(nav).getByText("Account");

    for (const s of SETTINGS_SECTIONS) {
      within(nav).getByText(s.label);
    }
  });

  it("renders sections in correct group order", () => {
    render(() => <SettingsTOC />);
    const nav = screen.getByRole("navigation", { name: "Settings navigation" });
    const buttons = within(nav).getAllByRole("button");
    const labels = buttons.map((b) => b.textContent);

    expect(labels).toEqual(SETTINGS_SECTIONS.map((s) => s.label));
  });
});

describe("SettingsTOC — active highlighting", () => {
  it("highlights the active section", async () => {
    Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
    Object.defineProperty(window, "scrollY", { value: 200, configurable: true });
    Object.defineProperty(document.documentElement, "scrollHeight", { value: 5000, configurable: true });

    render(() => <SettingsTOC />);
    const nav = screen.getByRole("navigation", { name: "Settings navigation" });

    const refreshEl = document.getElementById("refresh")!;
    observerCallback(
      [
        {
          target: refreshEl,
          isIntersecting: true,
          boundingClientRect: { top: 10 } as DOMRect,
          intersectionRatio: 1,
          intersectionRect: {} as DOMRect,
          rootBounds: null,
          time: 0,
        } as unknown as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver
    );

    await vi.waitFor(() => {
      const refreshBtn = within(nav).getByText("Refresh");
      expect(refreshBtn.className).toContain("bg-primary/10");
    });
  });
});

describe("SettingsTOC — scroll to section", () => {
  it("calls scrollIntoView with smooth behavior on click", () => {
    const mockScrollIntoView = vi.fn();
    vi.spyOn(document, "getElementById").mockReturnValue({
      scrollIntoView: mockScrollIntoView,
    } as unknown as HTMLElement);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));

    render(() => <SettingsTOC />);
    const nav = screen.getByRole("navigation", { name: "Settings navigation" });
    fireEvent.click(within(nav).getByText("API Usage"));

    expect(mockScrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
  });

  it("uses instant scroll with prefers-reduced-motion", () => {
    const mockScrollIntoView = vi.fn();
    vi.spyOn(document, "getElementById").mockReturnValue({
      scrollIntoView: mockScrollIntoView,
    } as unknown as HTMLElement);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));

    render(() => <SettingsTOC />);
    const nav = screen.getByRole("navigation", { name: "Settings navigation" });
    fireEvent.click(within(nav).getByText("API Usage"));

    expect(mockScrollIntoView).toHaveBeenCalledWith({
      behavior: "instant",
      block: "start",
    });
  });
});

describe("SettingsTOC — mobile dropdown", () => {
  it("toggles dropdown on button click", () => {
    render(() => <SettingsTOC />);
    const toggle = screen.getByRole("button", { expanded: false });
    fireEvent.click(toggle);
    expect(screen.getByTestId("mobile-toc").querySelector("#settings-toc-mobile")).toBeTruthy();
  });

  it("closes dropdown when a TOC item is clicked", () => {
    render(() => <SettingsTOC />);
    const mobileToc = screen.getByTestId("mobile-toc");
    const toggle = within(mobileToc).getByRole("button", { expanded: false });
    fireEvent.click(toggle);

    const dropdown = document.getElementById("settings-toc-mobile")!;
    const refreshBtn = within(dropdown).getByText("Refresh");

    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    const origGetById = document.getElementById.bind(document);
    vi.spyOn(document, "getElementById").mockImplementation((id: string) => {
      if (id === "settings-toc-mobile") return origGetById(id);
      const el = origGetById(id);
      if (el) {
        el.scrollIntoView = vi.fn();
        return el;
      }
      return null;
    });

    fireEvent.click(refreshBtn);

    expect(origGetById("settings-toc-mobile")).toBeNull();
  });

  it("closes dropdown on Escape key", () => {
    render(() => <SettingsTOC />);
    const mobileToc = screen.getByTestId("mobile-toc");
    const toggle = within(mobileToc).getByRole("button", { expanded: false });
    fireEvent.click(toggle);

    expect(document.getElementById("settings-toc-mobile")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.getElementById("settings-toc-mobile")).toBeNull();
  });

  it("closes dropdown on click outside", () => {
    render(() => <SettingsTOC />);
    const mobileToc = screen.getByTestId("mobile-toc");
    const toggle = within(mobileToc).getByRole("button", { expanded: false });
    fireEvent.click(toggle);

    expect(document.getElementById("settings-toc-mobile")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(document.getElementById("settings-toc-mobile")).toBeNull();
  });
});

describe("SettingsTOC — cleanup", () => {
  it("disconnects IntersectionObserver on unmount", () => {
    const { unmount } = render(() => <SettingsTOC />);
    unmount();
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it("removes event listeners on unmount when dropdown is open", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(() => <SettingsTOC />);
    const mobileToc = screen.getByTestId("mobile-toc");
    const toggle = within(mobileToc).getByRole("button", { expanded: false });
    fireEvent.click(toggle);

    unmount();

    const removedTypes = removeSpy.mock.calls.map((c) => c[0]);
    expect(removedTypes).toContain("pointerdown");
    expect(removedTypes).toContain("keydown");
  });
});

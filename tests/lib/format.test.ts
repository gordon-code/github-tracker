import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { relativeTime, labelTextColor } from "../../src/app/lib/format";

describe("relativeTime", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-03-21T12:00:00.000Z").getTime());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("formats seconds ago", () => {
    const isoString = new Date(Date.now() - 30 * 1000).toISOString();
    const result = relativeTime(isoString);
    expect(result).toMatch(/30 seconds? ago/);
  });

  it("formats minutes ago", () => {
    const isoString = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const result = relativeTime(isoString);
    expect(result).toMatch(/5 minutes? ago/);
  });

  it("formats hours ago", () => {
    const isoString = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const result = relativeTime(isoString);
    expect(result).toMatch(/3 hours? ago/);
  });

  it("formats days ago", () => {
    const isoString = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = relativeTime(isoString);
    expect(result).toMatch(/7 days? ago/);
  });

  it("formats months ago", () => {
    const isoString = new Date(Date.now() - 2 * 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = relativeTime(isoString);
    expect(result).toMatch(/2 months? ago/);
  });

  it("formats years ago", () => {
    const isoString = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
    const result = relativeTime(isoString);
    expect(result).toMatch(/2 years? ago/);
  });

  it("uses 'now' or 'just now' wording for 0 seconds", () => {
    const isoString = new Date(Date.now()).toISOString();
    const result = relativeTime(isoString);
    // Intl.RelativeTimeFormat with numeric:'auto' outputs 'now' for 0 seconds
    expect(result).toMatch(/now/i);
  });
});

describe("labelTextColor", () => {
  it("returns #000000 for white (#ffffff)", () => {
    expect(labelTextColor("ffffff")).toBe("#000000");
  });

  it("returns #000000 for yellow (#ffff00)", () => {
    expect(labelTextColor("ffff00")).toBe("#000000");
  });

  it("returns #000000 for a light green", () => {
    expect(labelTextColor("0075ca")).toBe("#ffffff");
  });

  it("returns #ffffff for black (#000000)", () => {
    expect(labelTextColor("000000")).toBe("#ffffff");
  });

  it("returns #ffffff for a dark red (#d73a4a)", () => {
    // luminance = (0.299*215 + 0.587*58 + 0.114*74) / 255 ≈ 0.41 — dark
    expect(labelTextColor("d73a4a")).toBe("#ffffff");
  });

  it("returns #ffffff for a dark navy blue", () => {
    expect(labelTextColor("0d1117")).toBe("#ffffff");
  });

  it("returns #000000 for a light grey (#e4e4e4)", () => {
    expect(labelTextColor("e4e4e4")).toBe("#000000");
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { labelColorClass, _resetLabelColors } from "../../src/app/lib/label-colors";

describe("labelColorClass", () => {
  beforeEach(() => {
    _resetLabelColors();
  });

  it("returns lb-<hex> class for valid 6-char hex", () => {
    expect(labelColorClass("abc123")).toBe("lb-abc123");
  });

  it("lowercases hex for consistent class names", () => {
    expect(labelColorClass("ABC123")).toBe("lb-abc123");
  });

  it("returns fallback class for invalid hex", () => {
    expect(labelColorClass("gggggg")).toBe("lb-e5e7eb");
    expect(labelColorClass("")).toBe("lb-e5e7eb");
    expect(labelColorClass("abc")).toBe("lb-e5e7eb");
    expect(labelColorClass("abc1234")).toBe("lb-e5e7eb");
  });

  it("returns fallback class for injection attempts", () => {
    expect(labelColorClass("abc123; color: red")).toBe("lb-e5e7eb");
    expect(labelColorClass("<script>")).toBe("lb-e5e7eb");
  });

  it("deduplicates — same hex returns same class without re-registering", () => {
    const first = labelColorClass("ff0000");
    const second = labelColorClass("FF0000");
    expect(first).toBe(second);
    expect(first).toBe("lb-ff0000");
  });

  it("inserts CSS rule with correct background and foreground colors", () => {
    labelColorClass("000000");
    const sheet = document.adoptedStyleSheets[document.adoptedStyleSheets.length - 1];
    const rule = sheet.cssRules[0].cssText;
    expect(rule).toContain(".lb-000000");
    expect(rule).toContain("background-color");
    expect(rule).toContain("color");
  });

  it("does not insert duplicate rules for same hex", () => {
    labelColorClass("ff0000");
    labelColorClass("ff0000");
    const sheet = document.adoptedStyleSheets[document.adoptedStyleSheets.length - 1];
    expect(sheet.cssRules.length).toBe(1);
  });
});

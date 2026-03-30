import { describe, it, expect } from "vitest";
import { expandEmoji } from "../../src/app/lib/emoji";

describe("expandEmoji", () => {
  it("expands known shortcodes to Unicode", () => {
    expect(expandEmoji(":microbe: bug")).toBe("🦠 bug");
    expect(expandEmoji(":sponge: formatter")).toBe("🧽 formatter");
    expect(expandEmoji(":rocket:")).toBe("🚀");
  });

  it("handles multiple shortcodes in one string", () => {
    expect(expandEmoji(":bug: :fire: critical")).toBe("🐛 🔥 critical");
  });

  it("leaves unknown shortcodes as-is", () => {
    expect(expandEmoji(":not_a_real_emoji:")).toBe(":not_a_real_emoji:");
  });

  it("returns plain text unchanged", () => {
    expect(expandEmoji("no emoji here")).toBe("no emoji here");
    expect(expandEmoji("")).toBe("");
  });

  it("handles mixed known and unknown shortcodes", () => {
    expect(expandEmoji(":rocket: :fakecode: go")).toBe("🚀 :fakecode: go");
  });

  it("does not expand partial colon patterns", () => {
    expect(expandEmoji("time: 3:00")).toBe("time: 3:00");
    expect(expandEmoji("key:value")).toBe("key:value");
  });
});

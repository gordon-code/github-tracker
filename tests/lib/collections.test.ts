import { describe, it, expect } from "vitest";
import { setsEqual } from "../../src/app/lib/collections";

describe("setsEqual", () => {
  it("returns true for identical sets", () => {
    expect(setsEqual(new Set([1, 2, 3]), new Set([1, 2, 3]))).toBe(true);
  });

  it("returns true for two empty sets", () => {
    expect(setsEqual(new Set(), new Set())).toBe(true);
  });

  it("returns false for different sizes", () => {
    expect(setsEqual(new Set([1, 2]), new Set([1]))).toBe(false);
  });

  it("returns false for same size but different elements", () => {
    expect(setsEqual(new Set([1, 2]), new Set([2, 3]))).toBe(false);
  });

  it("works with string sets", () => {
    expect(setsEqual(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
    expect(setsEqual(new Set(["a"]), new Set(["b"]))).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { isValidPatFormat } from "../../src/app/lib/pat";

/** Type-safe helper: asserts result is invalid and returns the error string */
function expectInvalid(result: ReturnType<typeof isValidPatFormat>): string {
  expect(result.valid).toBe(false);
  if (!result.valid) return result.error;
  throw new Error("unreachable");
}

describe("isValidPatFormat", () => {
  it("rejects empty string", () => {
    expect(expectInvalid(isValidPatFormat(""))).toBe("Please enter a token");
  });

  it("rejects whitespace-only string", () => {
    expect(expectInvalid(isValidPatFormat("   "))).toBe("Please enter a token");
  });

  it("rejects random string without valid prefix", () => {
    expect(expectInvalid(isValidPatFormat("some_random_token_value"))).toContain("should start with ghp_");
  });

  it("rejects ghp without underscore (not a truncation)", () => {
    expect(expectInvalid(isValidPatFormat("ghp" + "a".repeat(37)))).toContain("should start with ghp_");
  });

  it("rejects github_pat without trailing underscore", () => {
    expect(expectInvalid(isValidPatFormat("github_pat" + "a".repeat(37)))).toContain("should start with ghp_");
  });

  it("accepts valid classic PAT (ghp_ + 36 chars = 40 total)", () => {
    const token = "ghp_" + "a".repeat(36);
    expect(token.length).toBe(40);
    expect(isValidPatFormat(token).valid).toBe(true);
  });

  it("rejects classic PAT one char too short (39 total)", () => {
    const token = "ghp_" + "a".repeat(35);
    expect(token.length).toBe(39);
    expect(expectInvalid(isValidPatFormat(token))).toContain("truncated");
  });

  it("rejects very short classic PAT", () => {
    expect(expectInvalid(isValidPatFormat("ghp_abc"))).toContain("truncated");
  });

  it("accepts valid fine-grained PAT (github_pat_ + 69 chars = 80 total)", () => {
    const token = "github_pat_" + "a".repeat(69);
    expect(token.length).toBe(80);
    expect(isValidPatFormat(token).valid).toBe(true);
  });

  it("accepts realistic fine-grained PAT (~93 chars)", () => {
    const token = "github_pat_" + "a1b2c3d4e5".repeat(8) + "ab";
    expect(token.length).toBe(93);
    expect(isValidPatFormat(token).valid).toBe(true);
  });

  it("rejects fine-grained PAT one char too short (79 total)", () => {
    const token = "github_pat_" + "a".repeat(68);
    expect(token.length).toBe(79);
    expect(expectInvalid(isValidPatFormat(token))).toContain("truncated");
  });

  it("rejects very short fine-grained PAT", () => {
    expect(expectInvalid(isValidPatFormat("github_pat_short"))).toContain("truncated");
  });

  it("rejects truncated fine-grained PAT that would pass old minimum (47 chars)", () => {
    const token = "github_pat_" + "a".repeat(36);
    expect(token.length).toBe(47);
    expect(expectInvalid(isValidPatFormat(token))).toContain("truncated");
  });

  it("trims whitespace and validates underlying token", () => {
    const token = "  ghp_" + "a".repeat(36) + "  ";
    expect(isValidPatFormat(token).valid).toBe(true);
  });

  it("rejects bare prefix ghp_ as truncated (not invalid characters)", () => {
    expect(expectInvalid(isValidPatFormat("ghp_"))).toContain("truncated");
  });

  it("rejects token with invalid characters", () => {
    const token = "ghp_" + "abc!def" + "a".repeat(29);
    expect(expectInvalid(isValidPatFormat(token))).toContain("invalid characters");
  });

  it("accepts fine-grained PAT with underscores in payload", () => {
    const token = "github_pat_" + "abc_def_ghi_".repeat(6) + "abcdef";
    expect(token.length).toBeGreaterThanOrEqual(80);
    expect(isValidPatFormat(token).valid).toBe(true);
  });

  it("returns discriminated union — no error key when valid", () => {
    const result = isValidPatFormat("ghp_" + "a".repeat(36));
    expect(result.valid).toBe(true);
    expect("error" in result).toBe(false);
  });

  it("returns discriminated union — error present when invalid", () => {
    const result = isValidPatFormat("bad");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBeTruthy();
    }
  });
});

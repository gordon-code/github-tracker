import { describe, it, expect } from "vitest";
import { isValidPatFormat } from "../../src/app/lib/pat";

describe("isValidPatFormat", () => {
  it("rejects empty string", () => {
    const result = isValidPatFormat("");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Please enter a token");
  });

  it("rejects whitespace-only string", () => {
    const result = isValidPatFormat("   ");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Please enter a token");
  });

  it("rejects random string without valid prefix", () => {
    const result = isValidPatFormat("some_random_token_value");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("should start with ghp_");
  });

  it("rejects ghp without underscore (not a truncation)", () => {
    const result = isValidPatFormat("ghp" + "a".repeat(37));
    expect(result.valid).toBe(false);
    expect(result.error).toContain("should start with ghp_");
  });

  it("rejects github_pat without trailing underscore", () => {
    const result = isValidPatFormat("github_pat" + "a".repeat(37));
    expect(result.valid).toBe(false);
    expect(result.error).toContain("should start with ghp_");
  });

  it("accepts valid classic PAT (ghp_ + 36 chars = 40 total)", () => {
    const token = "ghp_" + "a".repeat(36);
    expect(token.length).toBe(40);
    const result = isValidPatFormat(token);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("rejects classic PAT one char too short (39 total)", () => {
    const token = "ghp_" + "a".repeat(35);
    expect(token.length).toBe(39);
    const result = isValidPatFormat(token);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("truncated");
  });

  it("rejects very short classic PAT", () => {
    const result = isValidPatFormat("ghp_abc");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("truncated");
  });

  it("accepts valid fine-grained PAT (github_pat_ + 36 chars = 47 total)", () => {
    const token = "github_pat_" + "a".repeat(36);
    expect(token.length).toBe(47);
    const result = isValidPatFormat(token);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("rejects fine-grained PAT one char too short (46 total)", () => {
    const token = "github_pat_" + "a".repeat(35);
    expect(token.length).toBe(46);
    const result = isValidPatFormat(token);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("truncated");
  });

  it("rejects very short fine-grained PAT", () => {
    const result = isValidPatFormat("github_pat_short");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("truncated");
  });

  it("trims whitespace and validates underlying token", () => {
    const token = "  ghp_" + "a".repeat(36) + "  ";
    const result = isValidPatFormat(token);
    expect(result.valid).toBe(true);
  });

  it("rejects bare prefix ghp_ as truncated (not invalid characters)", () => {
    const result = isValidPatFormat("ghp_");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("truncated");
  });

  it("rejects token with invalid characters", () => {
    const token = "ghp_" + "abc!def" + "a".repeat(29);
    const result = isValidPatFormat(token);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("invalid characters");
  });
});

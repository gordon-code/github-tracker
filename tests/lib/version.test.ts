import { describe, it, expect } from "vitest";
import {
  APP_VERSION,
  GIT_SHA,
  BUILD_TIME,
  displayVersion,
} from "../../src/app/lib/version";

describe("version metadata", () => {
  it("exposes build-time constants from Vite defines", () => {
    expect(APP_VERSION).toBe("0.1.0-test");
    expect(GIT_SHA).toBe("abcdef123456");
    expect(BUILD_TIME).toBe("2026-01-01T00:00:00.000Z");
  });

  it("formats displayVersion() as <APP_VERSION>+<7-char GIT_SHA>", () => {
    expect(displayVersion()).toBe(`${APP_VERSION}+${GIT_SHA.slice(0, 7)}`);
    expect(displayVersion()).toBe("0.1.0-test+abcdef1");
  });
});

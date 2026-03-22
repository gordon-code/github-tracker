import { describe, it, expect, beforeEach } from "vitest";
import {
  getErrors,
  pushError,
  dismissError,
  clearErrors,
} from "../../src/app/lib/errors";
import { createRoot } from "solid-js";

// errors.ts uses module-level signals — clearErrors() in beforeEach is essential
// to prevent state leaking between tests.
beforeEach(() => {
  clearErrors();
});

describe("getErrors", () => {
  it("returns empty array initially (after clear)", () => {
    createRoot((dispose) => {
      expect(getErrors()).toEqual([]);
      dispose();
    });
  });
});

describe("pushError", () => {
  it("adds an error with auto-generated id and timestamp", () => {
    createRoot((dispose) => {
      pushError("api", "Something went wrong");
      const errs = getErrors();
      expect(errs).toHaveLength(1);
      expect(errs[0].source).toBe("api");
      expect(errs[0].message).toBe("Something went wrong");
      expect(typeof errs[0].id).toBe("string");
      expect(errs[0].id.length).toBeGreaterThan(0);
      expect(typeof errs[0].timestamp).toBe("number");
      expect(errs[0].timestamp).toBeGreaterThan(0);
      dispose();
    });
  });

  it("sets retryable = false by default", () => {
    createRoot((dispose) => {
      pushError("api", "Network error");
      expect(getErrors()[0].retryable).toBe(false);
      dispose();
    });
  });

  it("sets retryable = true when passed", () => {
    createRoot((dispose) => {
      pushError("poll", "Timeout", true);
      expect(getErrors()[0].retryable).toBe(true);
      dispose();
    });
  });

  it("accumulates multiple errors", () => {
    createRoot((dispose) => {
      pushError("api", "Error 1");
      pushError("poll", "Error 2");
      pushError("auth", "Error 3");
      expect(getErrors()).toHaveLength(3);
      dispose();
    });
  });

  it("each error has a unique id", () => {
    createRoot((dispose) => {
      pushError("a", "msg1");
      pushError("b", "msg2");
      const ids = getErrors().map((e) => e.id);
      expect(new Set(ids).size).toBe(2);
      dispose();
    });
  });
});

describe("dismissError", () => {
  it("removes only the specified error by id", () => {
    createRoot((dispose) => {
      pushError("api", "Error A");
      pushError("poll", "Error B");
      const [errA, errB] = getErrors();
      dismissError(errA.id);
      const remaining = getErrors();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(errB.id);
      dispose();
    });
  });

  it("deduplicates errors by source — replaces message", () => {
    createRoot((dispose) => {
      pushError("api", "First error");
      pushError("api", "Updated error");
      const errs = getErrors();
      expect(errs).toHaveLength(1);
      expect(errs[0].message).toBe("Updated error");
      dispose();
    });
  });

  it("is a no-op for an unknown id", () => {
    createRoot((dispose) => {
      pushError("api", "Error A");
      dismissError("does-not-exist");
      expect(getErrors()).toHaveLength(1);
      dispose();
    });
  });
});

describe("clearErrors", () => {
  it("removes all errors", () => {
    createRoot((dispose) => {
      pushError("api", "Error 1");
      pushError("poll", "Error 2");
      clearErrors();
      expect(getErrors()).toHaveLength(0);
      dispose();
    });
  });

  it("is safe to call when there are no errors", () => {
    createRoot((dispose) => {
      expect(() => clearErrors()).not.toThrow();
      expect(getErrors()).toHaveLength(0);
      dispose();
    });
  });
});

import { describe, it, expect, vi } from "vitest";
import { discardResponseBody, rethrowIfUnauthorized } from "../../src/app/lib/http-errors";

describe("discardResponseBody", () => {
  it("cancels the body and tolerates a missing body or a rejected cancel", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    discardResponseBody({ body: { cancel } } as unknown as Response);
    expect(cancel).toHaveBeenCalledOnce();

    expect(() => discardResponseBody({ body: null } as unknown as Response)).not.toThrow();

    const rejecting = vi.fn().mockRejectedValue(new TypeError("locked"));
    discardResponseBody({ body: { cancel: rejecting } } as unknown as Response);
    await Promise.resolve();
    expect(rejecting).toHaveBeenCalledOnce();
  });
});

function caught(fn: () => void): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe("rethrowIfUnauthorized", () => {
  it("throws the original 401 reason object", () => {
    const err = { status: 401 };
    expect(
      caught(() =>
        rethrowIfUnauthorized([
          { status: "fulfilled", value: 1 },
          { status: "rejected", reason: err },
        ])
      )
    ).toBe(err);
  });

  it("throws a 401 nested under response.status", () => {
    const err = { response: { status: 401 } };
    expect(caught(() => rethrowIfUnauthorized([{ status: "rejected", reason: err }]))).toBe(err);
  });

  it("ignores non-401 rejections, fulfilled results, and empty input", () => {
    expect(() =>
      rethrowIfUnauthorized([
        { status: "fulfilled", value: 1 },
        { status: "rejected", reason: { status: 500 } },
        { status: "rejected", reason: new Error("network") },
      ])
    ).not.toThrow();
    expect(() => rethrowIfUnauthorized([])).not.toThrow();
  });
});

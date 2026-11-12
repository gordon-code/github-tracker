import { describe, it, expect } from "vitest";
import { hasPendingFields, mergeFieldsForWrite, takeForeignFields, toFieldJson } from "../../src/app/lib/persisted-fields";

describe("persisted-fields", () => {
  const baseline = () => toFieldJson({ a: 1, b: [1], c: { x: true } });

  it("hasPendingFields reports a change only when a key's JSON differs from the baseline", () => {
    expect(hasPendingFields({ a: 1, b: [1], c: { x: true } }, baseline())).toBe(false);
    expect(hasPendingFields({ a: 2, b: [1], c: { x: true } }, baseline())).toBe(true);
  });

  it("mergeFieldsForWrite overlays only pending and missing keys onto the on-disk blob", () => {
    const result = mergeFieldsForWrite({ a: 2, b: [1], c: { x: true } }, { a: 1, b: [9] }, baseline(), new Set());
    expect(result.merged).toEqual({ a: 2, b: [9], c: { x: true } });
    expect(result.writtenFields).toEqual({ a: "2", c: '{"x":true}' });
    expect(result.changed).toBe(true);
  });

  it("mergeFieldsForWrite reports no change when the overlay already matches disk", () => {
    const result = mergeFieldsForWrite({ a: 2, b: [1], c: { x: true } }, { a: 2, b: [1], c: { x: true } }, baseline(), new Set());
    expect(result.changed).toBe(false);
    expect(result.writtenFields).toEqual({ a: "2" });
  });

  it("mergeFieldsForWrite writes a forced key even when it matches the baseline", () => {
    const result = mergeFieldsForWrite({ a: 1, b: [1], c: { x: true } }, { a: 5, b: [1], c: { x: true } }, baseline(), new Set(["a"]));
    expect(result.merged.a).toBe(1);
    expect(result.writtenFields).toEqual({ a: "1" });
    expect(result.changed).toBe(true);
  });

  it("mergeFieldsForWrite reports a forced key already equal on disk as written but unchanged", () => {
    const result = mergeFieldsForWrite({ a: 1, b: [1], c: { x: true } }, { a: 1, b: [1], c: { x: true } }, baseline(), new Set(["a"]));
    expect(result.changed).toBe(false);
    expect(result.writtenFields).toEqual({ a: "1" });
  });

  it("mergeFieldsForWrite keeps a key that is on disk but not in the snapshot", () => {
    const result = mergeFieldsForWrite({ a: 2 }, { a: 1, extra: "kept" }, toFieldJson({ a: 1 }), new Set());
    expect(result.merged).toEqual({ a: 2, extra: "kept" });
  });

  it("mergeFieldsForWrite writes the whole snapshot when there is no on-disk blob", () => {
    const snapshot = { a: 1, b: [1], c: { x: true } };
    const result = mergeFieldsForWrite(snapshot, undefined, baseline(), new Set());
    expect(result.merged).toEqual(snapshot);
    expect(result.writtenFields).toEqual(toFieldJson(snapshot));
    expect(result.changed).toBe(true);
  });

  it("takeForeignFields adopts keys with no pending change and keeps pending local values", () => {
    const base = baseline();
    const patch = takeForeignFields({ a: 3, b: [7], c: { x: true } }, { a: 2, b: [1], c: { x: true } }, base, new Set());
    expect(patch).toEqual({ b: [7] });
    expect(base.b).toBe("[7]");
    expect(base.a).toBe("1");
  });

  it("takeForeignFields marks a kept pending key as forced so a later revert is still written", () => {
    const forced = new Set<string>();
    takeForeignFields({ a: 3, b: [1] }, { a: 2, b: [1], c: { x: true } }, baseline(), forced);
    expect([...forced]).toEqual(["a"]);
  });

  it("takeForeignFields skips forced keys and settles a pending key whose incoming value matches", () => {
    const base = baseline();
    const patch = takeForeignFields({ a: 2, b: [7] }, { a: 2, b: [1], c: { x: true } }, base, new Set(["b"]));
    expect(patch).toEqual({});
    expect(base.a).toBe("2");
    expect(base.b).toBe("[1]");
  });
});

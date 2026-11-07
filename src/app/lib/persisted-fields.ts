/**
 * Per-top-level-key persistence bookkeeping shared by the config and view-state stores,
 * which each keep one JSON blob in localStorage that every open tab reads and writes.
 *
 * Each store keeps a baseline: for every top-level key, the JSON of the value this tab
 * last wrote to localStorage, loaded from it, or adopted from another tab. A key whose
 * in-memory JSON differs from its baseline is a pending local change. A tab writes only
 * its pending (or forced) keys on top of whatever is on disk, and adopts another tab's
 * value for any key it has no pending change to, so a key this tab never changed is
 * never written back over a newer value saved by another tab.
 */

export type FieldBaseline = Record<string, string>;

export function toFieldJson(snapshot: Record<string, unknown>): FieldBaseline {
  const fields: FieldBaseline = {};
  for (const [key, value] of Object.entries(snapshot)) {
    fields[key] = JSON.stringify(value);
  }
  return fields;
}

export function hasPendingFields(snapshot: Record<string, unknown>, baseline: FieldBaseline): boolean {
  return Object.keys(snapshot).some((key) => JSON.stringify(snapshot[key]) !== baseline[key]);
}

interface FieldMergeResult {
  merged: Record<string, unknown>;
  writtenFields: FieldBaseline;
  changed: boolean;
}

/**
 * Builds the blob to write: the validated on-disk keys, overlaid with every key this tab
 * has a pending change to, every forced key, and every key missing from disk. Without a
 * readable on-disk blob (absent, unparseable, or a full overwrite) the whole snapshot is
 * written. `changed` is false when the overlay matches what is already on disk, so the
 * caller can skip the write. `writtenFields` holds the JSON of every overlaid key, for the
 * caller to fold into its baseline once the write has succeeded.
 */
export function mergeFieldsForWrite(
  snapshot: Record<string, unknown>,
  onDisk: Record<string, unknown> | undefined,
  baseline: FieldBaseline,
  forcedKeys: ReadonlySet<string>,
): FieldMergeResult {
  if (onDisk === undefined) {
    return { merged: { ...snapshot }, writtenFields: toFieldJson(snapshot), changed: true };
  }
  const merged: Record<string, unknown> = { ...onDisk };
  const writtenFields: FieldBaseline = {};
  let changed = false;
  for (const key of Object.keys(snapshot)) {
    const json = JSON.stringify(snapshot[key]);
    const missing = !Object.hasOwn(merged, key);
    if (!missing && !forcedKeys.has(key) && json === baseline[key]) continue;
    if (missing || JSON.stringify(merged[key]) !== json) changed = true;
    merged[key] = snapshot[key];
    writtenFields[key] = json;
  }
  return { merged, writtenFields, changed };
}

/**
 * Picks the values from another tab's validated blob that this tab should adopt: every key
 * whose incoming value differs from memory and that this tab has no pending or forced
 * change to. A pending local change keeps the local value and its key is added to
 * `forcedKeys` (mutated in place), so the local value is written on the next commit even if
 * the user later reverts it to the baseline value. Moves `baseline` (mutated in place) to
 * the incoming value for every adopted key and every key whose incoming value already
 * matches memory, so neither is written back.
 */
export function takeForeignFields(
  incoming: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  baseline: FieldBaseline,
  forcedKeys: Set<string>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (forcedKeys.has(key)) continue;
    const json = JSON.stringify(value);
    const current = JSON.stringify(snapshot[key]);
    if (json !== current) {
      if (current !== baseline[key]) {
        forcedKeys.add(key);
        continue;
      }
      patch[key] = value;
    }
    baseline[key] = json;
  }
  return patch;
}

import * as z from "zod/mini";

/** Number of leading git SHA characters carried in builds and `version.json`. */
export const BUILD_SHA_LENGTH = 12;

/** Number of leading git SHA characters shown in version labels and commit links. */
export const DISPLAY_SHA_LENGTH = 7;

/** Lowercase hex commit SHA, abbreviated (7) through full (40), as an unanchored pattern source. */
export const COMMIT_SHA_PATTERN = "[0-9a-f]{7,40}";

export const COMMIT_SHA_RE = new RegExp(`^${COMMIT_SHA_PATTERN}$`);

const BUILD_SHA_RE = new RegExp(`${COMMIT_SHA_RE.source}|^dev$`);

/** Shape of `version.json`, emitted at build time and fetched to detect new deployments. */
export const BuildInfoSchema = z.object({
  version: z.string().check(z.maxLength(32)),
  sha: z.string().check(z.regex(BUILD_SHA_RE)),
  builtAt: z.string().check(z.maxLength(40)),
  /** Fingerprint of the persisted config/view schema shape; absent in deployments that predate it. */
  schemaFp: z.optional(z.string().check(z.regex(/^[0-9a-f]{12}$/))),
});

export type BuildInfo = z.infer<typeof BuildInfoSchema>;

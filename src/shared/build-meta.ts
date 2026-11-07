import * as z from "zod/mini";

/** Number of leading git SHA characters carried in builds and `version.json`. */
export const BUILD_SHA_LENGTH = 12;

/** Shape of `version.json`, emitted at build time and fetched to detect new deployments. */
export const VersionInfoSchema = z.object({
  version: z.string().check(z.maxLength(32)),
  sha: z.string().check(z.regex(/^[0-9a-f]{7,40}$|^dev$/)),
  builtAt: z.string().check(z.maxLength(40)),
});

export type VersionInfo = z.infer<typeof VersionInfoSchema>;

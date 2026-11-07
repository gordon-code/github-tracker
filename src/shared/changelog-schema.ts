import * as z from "zod/mini";
import { COMMIT_SHA_RE } from "./build-meta.js";

export const CHANGELOG_MAX_ENTRIES = 20;
export const CHANGELOG_MAX_ITEM_TEXT_LENGTH = 300;
export const CHANGELOG_MAX_SECTION_TITLE_LENGTH = 100;

const ChangelogItemSchema = z.object({
  text: z.string().check(z.minLength(1), z.maxLength(CHANGELOG_MAX_ITEM_TEXT_LENGTH)),
  pr: z.optional(z.number().check(z.int(), z.positive())),
  sha: z.optional(z.string().check(z.regex(COMMIT_SHA_RE))),
});

export type ChangelogItem = z.infer<typeof ChangelogItemSchema>;

const ChangelogSectionSchema = z.object({
  title: z.string().check(z.minLength(1), z.maxLength(CHANGELOG_MAX_SECTION_TITLE_LENGTH)),
  items: z.array(ChangelogItemSchema),
});

export type ChangelogSection = z.infer<typeof ChangelogSectionSchema>;

const ChangelogEntrySchema = z.object({
  version: z.string().check(z.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)),
  date: z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/)),
  sections: z.array(ChangelogSectionSchema),
});

export type ChangelogEntry = z.infer<typeof ChangelogEntrySchema>;

export const ChangelogSchema = z.array(ChangelogEntrySchema).check(z.maxLength(CHANGELOG_MAX_ENTRIES));

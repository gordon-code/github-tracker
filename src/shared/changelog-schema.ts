import * as z from "zod/mini";

export const ChangelogItemSchema = z.object({
  text: z.string().check(z.minLength(1), z.maxLength(300)),
  pr: z.optional(z.number().check(z.int(), z.positive())),
  sha: z.optional(z.string().check(z.regex(/^[0-9a-f]{7,40}$/))),
});

export type ChangelogItem = z.infer<typeof ChangelogItemSchema>;

export const ChangelogSectionSchema = z.object({
  title: z.string().check(z.minLength(1), z.maxLength(100)),
  items: z.array(ChangelogItemSchema),
});

export type ChangelogSection = z.infer<typeof ChangelogSectionSchema>;

export const ChangelogEntrySchema = z.object({
  version: z.string().check(z.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)),
  date: z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/)),
  sections: z.array(ChangelogSectionSchema),
});

export type ChangelogEntry = z.infer<typeof ChangelogEntrySchema>;

export const ChangelogSchema = z.array(ChangelogEntrySchema).check(z.maxLength(20));

export type ChangelogData = z.infer<typeof ChangelogSchema>;

import { z } from "zod";

/**
 * Change marks of the person's own lists, carried by the events poll for
 * clients that ask (`lists=<LIST_MARKS_PROFILE>`). A mark changes whenever
 * the list may have changed (an item added, changed or removed, a meeting's
 * processing step); clients compare it with the mark of their last read and
 * read the list again only when it differs. The value is opaque: a server
 * restart changes every mark once.
 */
export const LIST_MARKS_PROFILE = "agent-list-marks/1" as const;
const mark = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/);
export const ListMarksSchema = z.strictObject({
  /** Open items (Tasks), both tabs. */
  tasks: mark,
  /** Meetings: list entries and their processing state. */
  meetings: mark,
});
export type ListMarks = z.infer<typeof ListMarksSchema>;
export type ListMarkName = keyof ListMarks;

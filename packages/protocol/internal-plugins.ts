import { z } from "zod";

export const TimeZone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    // Named zones only. Never inherit the operating system's timezone.
    if (value !== "UTC" && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+$/.test(value))
      return false;
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  });
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const weekday = z.number().int().min(1).max(7);
export const DateTimeInput = z
  .strictObject({
    when: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("date"),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
      z.strictObject({
        kind: z.literal("day_offset"),
        days: z.number().int().min(-3660).max(3660),
      }),
      z.strictObject({
        kind: z.literal("week_day"),
        weeks: z.number().int().min(-520).max(520),
        weekday,
      }),
      z.strictObject({ kind: z.literal("next_weekday"), weekday }),
      z.strictObject({
        kind: z.literal("elapsed"),
        minutes: z.number().int().min(-525600).max(525600),
      }),
    ]),
    time: time.optional(),
    timeZone: TimeZone.optional(),
    utcOffset: z
      .string()
      .regex(/^[+-](?:0\d|1[0-4]):[0-5]\d$/)
      .optional(),
    durationMinutes: z.number().int().min(1).max(10080).optional(),
    /** The whole local calendar day, from midnight to the next midnight. */
    wholeDay: z.boolean().optional(),
  })
  .superRefine((input, ctx) => {
    if (
      input.wholeDay &&
      (input.when.kind === "elapsed" ||
        input.time !== undefined ||
        input.durationMinutes !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "A whole day has no time, duration or elapsed minutes",
      });
    if (
      input.when.kind === "elapsed" &&
      (input.time !== undefined || input.utcOffset !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "Elapsed minutes cannot include a wall time or offset",
      });
  });
export const PluginResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("resolved"),
    values: z.record(
      z.string(),
      z.union([z.string().max(200), z.number().finite(), z.boolean()]),
    ),
  }),
  z.strictObject({
    status: z.literal("clarification"),
    reason: z.enum([
      "missing_time",
      "invalid_date",
      "ambiguous_time",
      "nonexistent_time",
      "invalid_offset",
    ]),
    localDateTime: z.string().optional(),
    timeZone: TimeZone,
    alternatives: z
      .array(z.strictObject({ utc: z.string(), utcOffset: z.string() }))
      .max(2)
      .optional(),
  }),
]);
export type PluginResult = z.infer<typeof PluginResultSchema>;

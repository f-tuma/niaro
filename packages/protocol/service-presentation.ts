import { z } from "zod";

const shortText = z.string().min(1).max(160);
const field = z.strictObject({
  label: z.string().max(100),
  value: z.string().max(500),
});
const fields = z.array(field).max(6);
const timestamp = z.iso
  .datetime({ offset: true })
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid timestamp");
const event = z
  .strictObject({
    title: shortText,
    start: timestamp,
    end: timestamp.optional(),
    location: shortText.optional(),
  })
  .refine(
    (value) => !value.end || Date.parse(value.end) >= Date.parse(value.start),
    { message: "Event end must not precede start", path: ["end"] },
  );

/** Bounded, passive display data selected by the server's capability mapper. */
export const ServicePresentationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("contacts"),
    items: z
      .array(
        z.strictObject({
          name: shortText,
          email: z.string().max(254).optional(),
          phone: z.string().max(64).optional(),
          subtitle: shortText.optional(),
        }),
      )
      .max(10),
    hasMore: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("events"),
    items: z.array(event).max(10),
    hasMore: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("records"),
    items: z
      .array(
        z.strictObject({
          title: shortText,
          subtitle: shortText.optional(),
          fields,
        }),
      )
      .max(10),
    hasMore: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("detail"), fields }),
  z.strictObject({ kind: z.literal("text"), text: z.string().max(1600) }),
]);

export type ServicePresentation = z.infer<typeof ServicePresentationSchema>;

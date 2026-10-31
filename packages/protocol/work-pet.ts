import { z } from "zod";
import { IdentityId } from "./identity";
import {
  MemoryItemSchema,
  MemoryContentSchema,
  MemoryKindSchema,
  ObservationSectionSchema,
} from "./memory";
export const WORK_PET_PROFILE = "work-pet/1" as const;
export const PetShapeSchema = z.enum([
  "circle",
  "pill",
  "cookie",
  "sunny",
  "flower",
  "clover",
  "burst",
  "pebble",
]);
export const PET_PALETTE = [
  { name: "Levandule", hex: "#BDB3FA", rgb: [0.74, 0.7, 0.98] },
  { name: "Máta", hex: "#9EEBD6", rgb: [0.62, 0.92, 0.84] },
  { name: "Broskev", hex: "#FFC7A8", rgb: [1, 0.78, 0.66] },
  { name: "Obloha", hex: "#9ECCFF", rgb: [0.62, 0.8, 1] },
  { name: "Citron", hex: "#FAED94", rgb: [0.98, 0.93, 0.58] },
  { name: "Růže", hex: "#FAB3D1", rgb: [0.98, 0.7, 0.82] },
  { name: "Šalvěj", hex: "#BDDBAD", rgb: [0.74, 0.86, 0.68] },
  { name: "Mlha", hex: "#D6D6E6", rgb: [0.84, 0.84, 0.9] },
] as const;
export const PetColourSchema = z.enum([
  "#BDB3FA",
  "#9EEBD6",
  "#FFC7A8",
  "#9ECCFF",
  "#FAED94",
  "#FAB3D1",
  "#BDDBAD",
  "#D6D6E6",
]);
export const PetSettingsSchema = z.strictObject({
  name: z.string().trim().min(1).max(40),
  colour: PetColourSchema,
  shape: z.union([z.literal("auto"), PetShapeSchema]),
  jobTitle: z.string().trim().max(120),
  department: z.string().trim().max(120),
  animate: z.boolean(),
  showInChat: z.boolean(),
});
export const SavePetProfileSchema = z.strictObject({
  requestId: IdentityId,
  revision: z.number().int().nonnegative(),
  settings: PetSettingsSchema,
});
const scope = {
  profile: z.literal(WORK_PET_PROFILE),
  organizationId: IdentityId,
  workspaceId: IdentityId,
  userId: IdentityId,
};
export const PetProfileSchema = z.strictObject({
  ...scope,
  revision: z.number().int().nonnegative(),
  settings: PetSettingsSchema,
  automaticShape: PetShapeSchema,
  look: z
    .array(
      z.strictObject({
        section: ObservationSectionSchema,
        weight: z.number().min(0).max(1),
      }),
    )
    .length(6)
    .superRefine((items, ctx) => {
      if (new Set(items.map((item) => item.section)).size !== 6)
        ctx.addIssue({ code: "custom", message: "pet_look_sections" });
    }),
});
export const PetMemoryQuerySchema = z.strictObject({
  origin: z.enum(["observed", "explicit"]).optional(),
  section: ObservationSectionSchema.optional(),
  personal: z.enum(["work", "personal"]).optional(),
  history: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    .optional(),
});
export const PetMemoryPageSchema = z.strictObject({
  ...scope,
  version: z.number().int().nonnegative(),
  enabled: z.boolean(),
  optOut: z.boolean(),
  personalThings: z.enum(["keep", "drop"]),
  items: z
    .array(MemoryItemSchema)
    .max(100)
    .superRefine((items, ctx) => {
      if (
        items.some((item) => item.scope !== "private") ||
        new Set(items.map((item) => item.id)).size !== items.length
      )
        ctx.addIssue({ code: "custom", message: "pet_memory_private" });
    }),
  nextCursor: z
    .string()
    .max(2048)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    .nullable(),
});
const command = { requestId: IdentityId };
const target = { id: IdentityId, revision: z.number().int().positive() };
export const PetMemoryCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...command,
    type: z.literal("remember"),
    content: MemoryContentSchema,
    kind: MemoryKindSchema,
  }),
  z.strictObject({
    ...command,
    ...target,
    type: z.literal("revise"),
    content: MemoryContentSchema,
  }),
  z.strictObject({ ...command, ...target, type: z.literal("forget") }),
  z.strictObject({ ...command, type: z.literal("forgetAll") }),
  z.strictObject({
    ...command,
    type: z.literal("preference"),
    optOut: z.boolean(),
  }),
  z.strictObject({
    ...command,
    type: z.literal("personalThings"),
    value: z.enum(["keep", "drop"]),
  }),
  z.strictObject({
    ...command,
    ...target,
    type: z.literal("classify"),
    personal: z.boolean(),
  }),
]);
export type PetSettings = z.infer<typeof PetSettingsSchema>;
export type PetProfile = z.infer<typeof PetProfileSchema>;
export type SavePetProfile = z.infer<typeof SavePetProfileSchema>;
export type PetMemoryQuery = z.infer<typeof PetMemoryQuerySchema>;
export type PetMemoryPage = z.infer<typeof PetMemoryPageSchema>;
export type PetMemoryCommand = z.infer<typeof PetMemoryCommandSchema>;

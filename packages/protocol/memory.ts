import { z } from "zod";
import { WorkspaceTarget } from "./connections";
import { IdentityId } from "./identity";
import { MessageSchema } from "./index";
import { MeetingId } from "./meetings";

export const MEMORY_DEFAULTS = {
  retentionDays: 365,
  maxContextChars: 4000,
  maxItems: 8,
  allowShared: false,
} as const;
export const MemorySettingsSchema = z.strictObject({
  retentionDays: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .default(MEMORY_DEFAULTS.retentionDays),
  maxContextChars: z
    .number()
    .int()
    .min(500)
    .max(12000)
    .default(MEMORY_DEFAULTS.maxContextChars),
  maxItems: z.number().int().min(1).max(20).default(MEMORY_DEFAULTS.maxItems),
  allowShared: z.boolean().default(MEMORY_DEFAULTS.allowShared),
});
export type MemorySettings = z.infer<typeof MemorySettingsSchema>;
export const MemoryKindSchema = z.enum(["preference", "fact", "note"]);
export const MemoryScopeSchema = z.enum(["private", "workspace"]);
export const MemoryStatusSchema = z.enum([
  "candidate",
  "active",
  "superseded",
  "deleted",
]);
export const MemoryContentSchema = z.string().trim().min(1).max(4000);
export const ObservationSectionSchema = z.enum([
  "work",
  "projects",
  "tools",
  "people",
  "style",
  "rhythm",
]);
export const ObservationStatementSchema = z.string().trim().min(1).max(300);
const observationAttribution = {
  sourceId: z.uuid(),
  at: z.iso.datetime(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
};
const chatObservationSource = z.strictObject({
  type: z.literal("chat"),
  ...observationAttribution,
  messageId: MessageSchema.shape.id,
});
const meetingObservationSource = z.strictObject({
  type: z.literal("meeting"),
  ...observationAttribution,
  meetingId: MeetingId,
});
export const ObservationSourceSchema = z.discriminatedUnion("type", [
  chatObservationSource,
  meetingObservationSource,
]);
export type ObservationSource = z.infer<typeof ObservationSourceSchema>;
export const ObservedMemorySourceSchema = z.strictObject({
  type: z.literal("observed"),
  section: ObservationSectionSchema,
  personal: z.boolean(),
  sources: z.array(ObservationSourceSchema).min(1).max(5),
});
const explicitSources = [
  z.strictObject({
    type: z.literal("user_note"),
  }),
  z.strictObject({
    type: z.literal("user_message"),
    commandId: MessageSchema.shape.id,
    conversationId: MessageSchema.shape.id.optional(),
  }),
  z.strictObject({
    type: z.literal("verified_operation"),
    operationId: IdentityId,
    serviceId: IdentityId,
    verifiedAt: z.iso.datetime(),
  }),
] as const;
export const MemorySourceSchema = z.discriminatedUnion("type", [
  ...explicitSources,
  ObservedMemorySourceSchema,
]);
export type MemorySource = z.infer<typeof MemorySourceSchema>;
const sourceLocation = {
  removed: z.boolean(),
  href: z
    .string()
    .max(500)
    .regex(/^\/(chat|meetings)\/[^?#]+$/)
    .nullable(),
};
export const ObservationSourceViewSchema = z
  .discriminatedUnion("type", [
    chatObservationSource.extend(sourceLocation),
    meetingObservationSource.extend(sourceLocation),
  ])
  .superRefine((source, ctx) => {
    if (source.removed !== (source.href === null))
      ctx.addIssue({ code: "custom", message: "observation_source_location" });
  });
export type ObservationSourceView = z.infer<typeof ObservationSourceViewSchema>;
const MemorySourceViewSchema = z.discriminatedUnion("type", [
  ...explicitSources,
  ObservedMemorySourceSchema.extend({
    sources: z.array(ObservationSourceViewSchema).min(1).max(5),
  }),
]);
export const MemoryItemSchema = z
  .strictObject({
    id: IdentityId,
    scope: MemoryScopeSchema,
    kind: MemoryKindSchema,
    status: MemoryStatusSchema,
    revision: z.number().int().positive(),
    content: MemoryContentSchema.nullable(),
    source: MemorySourceViewSchema.nullable(),
    origin: z.enum(["explicit", "observed"]).default("explicit"),
    seenAt: z.iso.datetime().nullable().default(null),
    trust: z
      .enum(["user_assertion", "verified_result", "model_inference"])
      .nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
    supersedesId: IdentityId.nullable(),
  })
  .superRefine((item, ctx) => {
    if (item.status === "deleted") return;
    if (item.origin === "observed") {
      if (
        item.source?.type !== "observed" ||
        item.scope !== "private" ||
        item.trust !== "model_inference" ||
        item.seenAt === null ||
        !ObservationStatementSchema.safeParse(item.content).success ||
        item.kind !== (item.source.section === "style" ? "preference" : "fact")
      )
        ctx.addIssue({ code: "custom", message: "memory_observation_invalid" });
    } else if (item.source?.type === "observed") {
      ctx.addIssue({ code: "custom", message: "memory_observation_origin" });
    }
  });
export type MemoryItem = z.infer<typeof MemoryItemSchema>;
export const MemoryViewSchema = WorkspaceTarget.extend({
  profile: z.literal("agent-memory/1"),
  version: z.number().int().nonnegative(),
  enabled: z.boolean(),
  canManageShared: z.boolean(),
  optOut: z.boolean(),
  personalThings: z.enum(["keep", "drop"]).default("keep"),
  total: z.number().int().nonnegative().optional(),
  items: z.array(MemoryItemSchema).max(200),
});
export type MemoryView = z.infer<typeof MemoryViewSchema>;
const command = WorkspaceTarget.extend({ requestId: IdentityId });
const expectedRevision = z.number().int().positive();
export const MemoryReadQuerySchema = WorkspaceTarget.extend({
  scope: z.literal("private").optional(),
});
/** Source provenance, trust and the authenticated user are always established by the server. */
export const MemoryCommandSchema = z.discriminatedUnion("type", [
  command.extend({
    type: z.literal("remember"),
    content: MemoryContentSchema,
    kind: MemoryKindSchema,
    scope: MemoryScopeSchema.default("private"),
  }),
  command.extend({
    type: z.literal("revise"),
    id: IdentityId,
    revision: expectedRevision,
    content: MemoryContentSchema,
  }),
  command.extend({
    type: z.literal("forget"),
    id: IdentityId,
    revision: expectedRevision,
  }),
  command.extend({
    type: z.literal("preference"),
    optOut: z.boolean(),
  }),
  command.extend({
    type: z.literal("forgetAll"),
    scope: z.literal("private"),
  }),
  command.extend({
    type: z.literal("classify"),
    id: IdentityId,
    revision: expectedRevision,
    personal: z.boolean(),
  }),
  command.extend({
    type: z.literal("personalThings"),
    value: z.enum(["keep", "drop"]),
  }),
]);
export type MemoryCommand = z.infer<typeof MemoryCommandSchema>;
